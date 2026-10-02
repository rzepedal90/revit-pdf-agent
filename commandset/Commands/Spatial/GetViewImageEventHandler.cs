// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using Rectangle = System.Drawing.Rectangle;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Commands.Spatial
{
    /// <summary>
    /// Read-only: exports a view to PNG (outside any transaction, view settings untouched), optionally crops it
    /// to a model-space rectangle, downsizes it, and reports the pixel to model mapping.
    /// </summary>
    public class GetViewImageEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private long? _viewId;
        private int _pixelSize;
        private double[] _cropMm;

        public JObject Result { get; private set; }
        public string Error { get; private set; }

        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetParameters(long? viewId, int pixelSize, double[] cropMm)
        {
            _viewId = viewId;
            _pixelSize = pixelSize;
            _cropMm = cropMm;
            Result = null;
            Error = null;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            string tempDir = null;
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;

                View view;
                if (_viewId.HasValue)
                {
                    view = doc.GetElement(SpatialUtils.MakeId(_viewId.Value)) as View;
                    if (view == null) throw new Exception("No View with id " + _viewId.Value);
                }
                else
                {
                    view = doc.ActiveView;
                }
                if (view == null) throw new Exception("No view available.");
                if (view.IsTemplate) throw new Exception("Cannot export a view template; pass a concrete viewId.");

                // ---- View extent in model space (mm) ----
                var frame = ComputeFrame(view);

                // ---- Choose export size: if a crop rectangle is requested, export larger so the crop keeps detail ----
                double fullW = frame.WidthMm, fullH = frame.HeightMm;
                double exportLong = _pixelSize;
                if (_cropMm != null && frame.IsPlanAligned)
                {
                    double cw = Math.Min(_cropMm[2], frame.TopLeftX + fullW) - Math.Max(_cropMm[0], frame.TopLeftX);
                    double ch = Math.Min(_cropMm[3], frame.TopLeftY) - Math.Max(_cropMm[1], frame.TopLeftY - fullH);
                    if (cw > 0 && ch > 0)
                    {
                        double ratio = Math.Max(fullW, fullH) / Math.Max(cw, ch);
                        exportLong = Math.Min(8000, _pixelSize * ratio);
                    }
                }
                int exportPx = (int)Math.Max(64, Math.Round(exportLong));

                tempDir = Path.Combine(Path.GetTempPath(), "revitmcp_" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tempDir);

                var options = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews,
                    ImageResolution = ImageResolution.DPI_150,
                    ZoomType = ZoomFitType.FitToPage,
                    PixelSize = exportPx,
                    FitDirection = fullW >= fullH ? FitDirectionType.Horizontal : FitDirectionType.Vertical,
                    HLRandWFViewsFileType = ImageFileType.PNG,
                    ShadowViewsFileType = ImageFileType.PNG,
                    FilePath = Path.Combine(tempDir, "export"),
                };
                options.SetViewsAndSheets(new List<ElementId> { view.Id });
                doc.ExportImage(options); // must run outside a transaction

                var pngs = Directory.GetFiles(tempDir, "*.png");
                if (pngs.Length == 0) throw new Exception("Image export produced no output. The view may be empty or unsupported.");
                var rawBytes = File.ReadAllBytes(pngs[0]);

                int outW, outH;
                double tlX = frame.TopLeftX, tlY = frame.TopLeftY;
                double mmPerPxX, mmPerPxY;
                byte[] outBytes;

                using (var ms = new MemoryStream(rawBytes))
                using (var src = new Bitmap(ms))
                {
                    int srcW = src.Width, srcH = src.Height;
                    mmPerPxX = fullW / srcW;
                    mmPerPxY = fullH / srcH;

                    // Crop to the requested model rectangle
                    Rectangle rect = new Rectangle(0, 0, srcW, srcH);
                    bool cropped = false;
                    if (_cropMm != null)
                    {
                        if (!frame.IsPlanAligned)
                            throw new Exception("cropMm requires a view whose right/up directions are the model X/Y axes (plan view).");
                        int x0 = (int)Math.Floor((_cropMm[0] - tlX) / mmPerPxX);
                        int x1 = (int)Math.Ceiling((_cropMm[2] - tlX) / mmPerPxX);
                        int y0 = (int)Math.Floor((tlY - _cropMm[3]) / mmPerPxY);
                        int y1 = (int)Math.Ceiling((tlY - _cropMm[1]) / mmPerPxY);
                        x0 = Math.Max(0, x0); y0 = Math.Max(0, y0);
                        x1 = Math.Min(srcW, x1); y1 = Math.Min(srcH, y1);
                        if (x1 - x0 < 1 || y1 - y0 < 1)
                            throw new Exception("cropMm does not intersect the view extents.");
                        rect = new Rectangle(x0, y0, x1 - x0, y1 - y0);
                        cropped = true;
                        tlX += x0 * mmPerPxX;
                        tlY -= y0 * mmPerPxY;
                    }

                    // Downscale so that the long edge <= pixelSize
                    int long0 = Math.Max(rect.Width, rect.Height);
                    double scale = long0 > _pixelSize ? (double)_pixelSize / long0 : 1.0;
                    outW = Math.Max(1, (int)Math.Round(rect.Width * scale));
                    outH = Math.Max(1, (int)Math.Round(rect.Height * scale));
                    double mmX = mmPerPxX * rect.Width / outW;
                    double mmY = mmPerPxY * rect.Height / outH;

                    if (!cropped && scale >= 1.0)
                    {
                        outBytes = rawBytes;
                    }
                    else
                    {
                        using (var dst = new Bitmap(outW, outH, PixelFormat.Format32bppArgb))
                        {
                            using (var g = Graphics.FromImage(dst))
                            {
                                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                                g.SmoothingMode = SmoothingMode.HighQuality;
                                g.DrawImage(src, new Rectangle(0, 0, outW, outH), rect, GraphicsUnit.Pixel);
                            }
                            using (var os = new MemoryStream())
                            {
                                dst.Save(os, ImageFormat.Png);
                                outBytes = os.ToArray();
                            }
                        }
                    }
                    mmPerPxX = mmX;
                    mmPerPxY = mmY;
                }

                var result = new JObject
                {
                    ["viewId"] = SpatialUtils.IdValue(view.Id),
                    ["viewName"] = view.Name,
                    ["viewType"] = view.ViewType.ToString(),
                    ["scale"] = view.Scale,
                    ["width"] = outW,
                    ["height"] = outH,
                    ["mimeType"] = "image/png",
                    ["mapping"] = new JObject
                    {
                        ["pixel00ModelXYmm"] = new JArray(Math.Round(tlX, 3), Math.Round(tlY, 3)),
                        ["mmPerPixelX"] = Math.Round(mmPerPxX, 6),
                        ["mmPerPixelY"] = Math.Round(mmPerPxY, 6),
                        ["formula"] = "modelX = x0 + px*mmPerPixelX ; modelY = y0 - py*mmPerPixelY (plan view; origin top-left, y down in image)",
                        ["rightDirection"] = SpatialUtils.Dir(view.RightDirection),
                        ["upDirection"] = SpatialUtils.Dir(view.UpDirection),
                        ["planAligned"] = frame.IsPlanAligned,
                        ["extentSource"] = frame.Source,
                        ["viewExtentMm"] = new JArray(Math.Round(fullW, 3), Math.Round(fullH, 3)),
                        ["outlineExtentMm"] = new JArray(Math.Round(frame.OutlineWidthMm, 3), Math.Round(frame.OutlineHeightMm, 3)),
                        ["note"] = frame.Note,
                    },
                    ["imageBase64"] = Convert.ToBase64String(outBytes),
                };
                Result = result;
            }
            catch (Exception ex)
            {
                Error = "get_view_image failed: " + ex.Message;
            }
            finally
            {
                if (tempDir != null)
                {
                    try { Directory.Delete(tempDir, true); } catch { }
                }
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName() => "get_view_image";

        private class Frame
        {
            public double TopLeftX, TopLeftY; // model mm of the image top-left
            public double WidthMm, HeightMm;  // model extent covered by the image
            public double OutlineWidthMm, OutlineHeightMm;
            public bool IsPlanAligned;
            public string Source;
            public string Note;
        }

        /// <summary>
        /// Model-space extent of the exported image. With an active crop box the exported image is the crop region,
        /// so the crop box is authoritative. Otherwise the view Outline (paper feet) scaled by View.Scale is used for
        /// the size and the view origin for placement (less reliable; verify against known grids).
        /// </summary>
        private static Frame ComputeFrame(View view)
        {
            var f = new Frame();
            var right = view.RightDirection;
            var up = view.UpDirection;
            f.IsPlanAligned = Math.Abs(right.X - 1) < 1e-6 && Math.Abs(up.Y - 1) < 1e-6;

            double scale = view.Scale > 0 ? view.Scale : 1;
            var outline = view.Outline;
            f.OutlineWidthMm = (outline.Max.U - outline.Min.U) * scale * SpatialUtils.FeetToMm;
            f.OutlineHeightMm = (outline.Max.V - outline.Min.V) * scale * SpatialUtils.FeetToMm;

            bool cropActive = false;
            try { cropActive = view.CropBoxActive; } catch { }

            if (cropActive)
            {
                var cb = view.CropBox;
                var t = cb.Transform;
                var tl = t.OfPoint(new XYZ(cb.Min.X, cb.Max.Y, 0));
                f.TopLeftX = tl.X * SpatialUtils.FeetToMm;
                f.TopLeftY = tl.Y * SpatialUtils.FeetToMm;
                f.WidthMm = (cb.Max.X - cb.Min.X) * SpatialUtils.FeetToMm;
                f.HeightMm = (cb.Max.Y - cb.Min.Y) * SpatialUtils.FeetToMm;
                f.Source = "cropBox";
                f.Note = "Extent taken from the active crop box; Outline extent given for cross-check.";
            }
            else
            {
                // Outline is relative to the view in paper units; scale to model and place around the view origin.
                var o = view.Origin;
                f.WidthMm = f.OutlineWidthMm;
                f.HeightMm = f.OutlineHeightMm;
                f.TopLeftX = (o.X + right.X * outline.Min.U * scale + up.X * outline.Max.V * scale) * SpatialUtils.FeetToMm;
                f.TopLeftY = (o.Y + right.Y * outline.Min.U * scale + up.Y * outline.Max.V * scale) * SpatialUtils.FeetToMm;
                f.Source = "outline";
                f.Note = "No active crop box: extent derived from View.Outline*Scale placed at view origin. UNVERIFIED; check against known grid positions (get_spatial_reference) or activate the crop box.";
            }
            return f;
        }
    }
}
