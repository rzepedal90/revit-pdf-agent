// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Commands.Spatial
{
    /// <summary>Read-only: grids, image instances, other elements and the view frame, in mm and feet.</summary>
    public class GetSpatialReferenceEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private List<long> _ids;
        private long? _viewId;

        public JObject Result { get; private set; }
        public string Error { get; private set; }

        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetParameters(List<long> ids, long? viewId)
        {
            _ids = ids;
            _viewId = viewId;
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
            try
            {
                var doc = app.ActiveUIDocument.Document;

                View view = null;
                if (_viewId.HasValue)
                {
                    view = doc.GetElement(SpatialUtils.MakeId(_viewId.Value)) as View;
                    if (view == null) throw new Exception("No View with id " + _viewId.Value);
                }

                var elements = new List<Element>();
                var seen = new HashSet<long>();
                foreach (var id in _ids)
                {
                    if (!seen.Add(id)) continue;
                    var el = doc.GetElement(SpatialUtils.MakeId(id));
                    if (el == null) throw new Exception("No element with id " + id);
                    elements.Add(el);
                }

                var rows = new JArray();
                foreach (var el in elements) rows.Add(DescribeElement(doc, el, view));

                var result = new JObject
                {
                    ["units"] = "point = {mm:[x,y,z], ft:[x,y,z]}; model coordinates",
                    ["elements"] = rows,
                    ["gridIntersections"] = GridIntersections(elements.OfType<Grid>().ToList()),
                };
                if (view != null) result["view"] = DescribeView(view);
                Result = result;
            }
            catch (Exception ex)
            {
                Error = "get_spatial_reference failed: " + ex.Message;
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName() => "get_spatial_reference";

        private static JObject DescribeElement(Document doc, Element el, View view)
        {
            var row = new JObject
            {
                ["id"] = SpatialUtils.IdValue(el.Id),
                ["name"] = el.Name,
                ["category"] = el.Category?.Name,
                ["pinned"] = el.Pinned,
            };

            if (el is Grid grid)
            {
                row["kind"] = "grid";
                row["grid"] = DescribeGrid(grid, view);
            }
            else if (el is ImageInstance image)
            {
                row["kind"] = "image";
                row["image"] = DescribeImage(doc, image);
            }
            else
            {
                row["kind"] = "element";
                row["className"] = el.GetType().Name;
                var loc = el.Location;
                if (loc is LocationPoint lp)
                    row["locationPoint"] = SpatialUtils.Pt(lp.Point);
                else if (loc is LocationCurve lc && lc.Curve != null && lc.Curve.IsBound)
                    row["locationCurve"] = new JObject
                    {
                        ["start"] = SpatialUtils.Pt(lc.Curve.GetEndPoint(0)),
                        ["end"] = SpatialUtils.Pt(lc.Curve.GetEndPoint(1)),
                    };
                row["bbox"] = SpatialUtils.Box(SafeBox(el, view));
            }
            return row;
        }

        private static JObject DescribeGrid(Grid grid, View view)
        {
            var o = new JObject();
            var curve = grid.Curve;
            o["isLine"] = curve is Line;
            if (curve != null && curve.IsBound)
            {
                var a = curve.GetEndPoint(0);
                var b = curve.GetEndPoint(1);
                o["start"] = SpatialUtils.Pt(a);
                o["end"] = SpatialUtils.Pt(b);
                var d = b - a;
                if (d.GetLength() > 1e-9) o["direction"] = SpatialUtils.Dir(d.Normalize());
            }
            if (view != null)
            {
                try
                {
                    var vc = grid.GetCurvesInView(DatumExtentType.ViewSpecific, view);
                    if (vc != null && vc.Count > 0 && vc[0].IsBound)
                        o["viewExtent"] = new JObject
                        {
                            ["start"] = SpatialUtils.Pt(vc[0].GetEndPoint(0)),
                            ["end"] = SpatialUtils.Pt(vc[0].GetEndPoint(1)),
                        };
                }
                catch { }
            }
            return o;
        }

        private static JArray GridIntersections(List<Grid> grids)
        {
            var rows = new JArray();
            for (int i = 0; i < grids.Count; i++)
            {
                for (int j = i + 1; j < grids.Count; j++)
                {
                    var l1 = grids[i].Curve as Line;
                    var l2 = grids[j].Curve as Line;
                    if (l1 == null || l2 == null) continue;
                    var p = l1.GetEndPoint(0); var p2 = l1.GetEndPoint(1);
                    var q = l2.GetEndPoint(0); var q2 = l2.GetEndPoint(1);
                    double rx = p2.X - p.X, ry = p2.Y - p.Y, sx = q2.X - q.X, sy = q2.Y - q.Y;
                    double den = rx * sy - ry * sx;
                    if (Math.Abs(den) < 1e-12) continue; // parallel
                    double qpx = q.X - p.X, qpy = q.Y - p.Y;
                    double t = (qpx * sy - qpy * sx) / den;
                    double u = (qpx * ry - qpy * rx) / den;
                    rows.Add(new JObject
                    {
                        ["a"] = grids[i].Name,
                        ["b"] = grids[j].Name,
                        ["aId"] = SpatialUtils.IdValue(grids[i].Id),
                        ["bId"] = SpatialUtils.IdValue(grids[j].Id),
                        ["point"] = SpatialUtils.Pt(new XYZ(p.X + t * rx, p.Y + t * ry, p.Z)),
                        ["withinBothExtents"] = t >= 0 && t <= 1 && u >= 0 && u <= 1,
                    });
                }
            }
            return rows;
        }

        private static JObject DescribeImage(Document doc, ImageInstance image)
        {
            var o = new JObject();
            try
            {
                var type = doc.GetElement(image.GetTypeId()) as ImageType;
                if (type != null)
                {
                    o["typeName"] = type.Name;
                    try { o["sourcePath"] = type.Path; } catch { }
                }
            }
            catch { }
            o["ownerViewId"] = SpatialUtils.IdOrNull(image.OwnerViewId);
            o["widthMm"] = Math.Round(image.Width * SpatialUtils.FeetToMm, 3);
            o["heightMm"] = Math.Round(image.Height * SpatialUtils.FeetToMm, 3);
            o["widthFt"] = Math.Round(image.Width, 6);
            o["heightFt"] = Math.Round(image.Height, 6);
            try { o["widthScale"] = image.WidthScale; o["heightScale"] = image.HeightScale; } catch { }
            try { o["lockProportions"] = image.LockProportions; } catch { }

            bool placed = false;
#if REVIT2022_OR_GREATER
            try
            {
                o["corners"] = new JObject
                {
                    ["topLeft"] = SpatialUtils.Pt(image.GetLocation(BoxPlacement.TopLeft)),
                    ["topRight"] = SpatialUtils.Pt(image.GetLocation(BoxPlacement.TopRight)),
                    ["bottomRight"] = SpatialUtils.Pt(image.GetLocation(BoxPlacement.BottomRight)),
                    ["bottomLeft"] = SpatialUtils.Pt(image.GetLocation(BoxPlacement.BottomLeft)),
                };
                o["center"] = SpatialUtils.Pt(image.GetLocation(BoxPlacement.Center));
                o["cornersSource"] = "ImageInstance.GetLocation(BoxPlacement)";
                placed = true;
            }
            catch { }
#endif
            if (!placed)
            {
                // Fallback: bounding box in the owner view (axis-aligned; ignores image rotation).
                View owner = null;
                try { owner = doc.GetElement(image.OwnerViewId) as View; } catch { }
                var bb = SafeBox(image, owner);
                if (bb != null)
                {
                    double z = bb.Min.Z;
                    o["corners"] = new JObject
                    {
                        ["topLeft"] = SpatialUtils.Pt(new XYZ(bb.Min.X, bb.Max.Y, z)),
                        ["topRight"] = SpatialUtils.Pt(new XYZ(bb.Max.X, bb.Max.Y, z)),
                        ["bottomRight"] = SpatialUtils.Pt(new XYZ(bb.Max.X, bb.Min.Y, z)),
                        ["bottomLeft"] = SpatialUtils.Pt(new XYZ(bb.Min.X, bb.Min.Y, z)),
                    };
                    o["center"] = SpatialUtils.Pt(new XYZ((bb.Min.X + bb.Max.X) / 2, (bb.Min.Y + bb.Max.Y) / 2, z));
                    o["cornersSource"] = "bbox in owner view (fallback; assumes unrotated image)";
                }
                o["bbox"] = SpatialUtils.Box(bb);
            }
            return o;
        }

        private static JObject DescribeView(View view)
        {
            var o = new JObject
            {
                ["id"] = SpatialUtils.IdValue(view.Id),
                ["name"] = view.Name,
                ["viewType"] = view.ViewType.ToString(),
                ["scale"] = view.Scale,
            };
            try
            {
                o["viewDirection"] = SpatialUtils.Dir(view.ViewDirection);
                o["rightDirection"] = SpatialUtils.Dir(view.RightDirection);
                o["upDirection"] = SpatialUtils.Dir(view.UpDirection);
                o["origin"] = SpatialUtils.Pt(view.Origin);
            }
            catch { }
            try
            {
                o["cropBoxActive"] = view.CropBoxActive;
                var cb = view.CropBox;
                o["cropBox"] = SpatialUtils.Box(cb);
                if (cb != null)
                {
                    // Crop box corners in model coordinates: bottom-left, bottom-right, top-right, top-left.
                    var t = cb.Transform;
                    var z = cb.Min.Z;
                    o["cropBoxModelCorners"] = new JArray(
                        SpatialUtils.Pt(t.OfPoint(new XYZ(cb.Min.X, cb.Min.Y, z))),
                        SpatialUtils.Pt(t.OfPoint(new XYZ(cb.Max.X, cb.Min.Y, z))),
                        SpatialUtils.Pt(t.OfPoint(new XYZ(cb.Max.X, cb.Max.Y, z))),
                        SpatialUtils.Pt(t.OfPoint(new XYZ(cb.Min.X, cb.Max.Y, z))));
                }
            }
            catch { }
            return o;
        }

        private static BoundingBoxXYZ SafeBox(Element el, View view)
        {
            try { return el.get_BoundingBox(view); } catch { return null; }
        }
    }
}
