using System.IO;
using Autodesk.Revit.DB;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.ElementQuery;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.CadGeometry
{
    /// <summary>
    /// Read-only (no transaction). Walks ImportInstance geometry (GeometryInstance -> Line/Arc/PolyLine/Solid),
    /// resolves the CAD layer of each object and returns layer summaries or bounded geometry in model coordinates (mm).
    /// </summary>
    public class GetCadGeometryEventHandler : ElementQueryHandlerBase
    {
        private const double FtToMm = 304.8;
        private const int DefaultLimit = 2000, MaxLimit = 20000;

        private class Rec
        {
            public string Kind;      // l, a, p, s
            public string Layer;
            public long ImportId;
            public List<double[]> Pts = new List<double[]>(); // xyz mm (line: a,b; polyline: vertices)
            public double[] C, Start, End; // arc
            public double R; public bool Full;
            public bool Closed; public double Area; public double[] Centroid;
            public double Volume;
            public double MinX = double.MaxValue, MinY = double.MaxValue, MaxX = double.MinValue, MaxY = double.MinValue;
            public double MinZ = double.MaxValue, MaxZ = double.MinValue;
            public double Length;
            public void Grow(double x, double y, double z)
            {
                if (x < MinX) MinX = x; if (x > MaxX) MaxX = x;
                if (y < MinY) MinY = y; if (y > MaxY) MaxY = y;
                if (z < MinZ) MinZ = z; if (z > MaxZ) MaxZ = z;
            }
        }

        private class LayerInfo { public string Name; public Category Cat; public bool Match; }

        private static double R1(double v) => Math.Round(v, 1);
        private static double[] Mm(XYZ p) => new[] { p.X * FtToMm, p.Y * FtToMm, p.Z * FtToMm };

        protected override JObject Run(Document doc, JObject p)
        {
            string mode = (ElementQueryUtils.GetString(p, "mode") ?? "layers").ToLowerInvariant();
            if (mode != "layers" && mode != "geometry") throw new ArgumentException("'mode' must be 'layers' or 'geometry'.");

            var patterns = StringList(p["layers"]);
            var kinds = StringList(p["kinds"]);
            HashSet<string> kindSet = null;
            if (kinds != null && kinds.Count > 0)
            {
                kindSet = new HashSet<string>();
                foreach (var k in kinds)
                {
                    switch (k.ToLowerInvariant())
                    {
                        case "line": kindSet.Add("l"); break;
                        case "arc": kindSet.Add("a"); break;
                        case "polyline": kindSet.Add("p"); break;
                        case "solid": kindSet.Add("s"); break;
                        default: throw new ArgumentException("Unknown kind '" + k + "' (use line, arc, polyline, solid).");
                    }
                }
            }

            double[] bbox = null;
            if (p["bboxMm"] is JObject bb)
            {
                bbox = new[] { bb.Value<double>("minX"), bb.Value<double>("minY"), bb.Value<double>("maxX"), bb.Value<double>("maxY") };
                if (bbox[2] < bbox[0] || bbox[3] < bbox[1]) throw new ArgumentException("bboxMm must satisfy max >= min.");
            }
            double minLen = 0;
            if (p["simplify"] is JObject sm && sm["minLengthMm"] != null && sm["minLengthMm"].Type != JTokenType.Null)
                minLen = Math.Max(0, sm.Value<double>("minLengthMm"));
            int limit = Math.Max(1, Math.Min(MaxLimit, ElementQueryUtils.GetInt(p, "limit", DefaultLimit)));
            int offset = Math.Max(0, ElementQueryUtils.GetInt(p, "offset", 0));
            string outFile = ElementQueryUtils.GetString(p, "outFile");
            if (outFile != null && !Path.IsPathRooted(outFile)) throw new ArgumentException("'outFile' must be an absolute path.");

            View view = null;
            long viewId = ElementQueryUtils.GetInt(p, "viewId", 0);
            if (p["viewId"] != null && p["viewId"].Type != JTokenType.Null) viewId = p["viewId"].Value<long>();
            if (viewId > 0)
            {
                view = doc.GetElement(ElementQueryUtils.ToElementId(viewId)) as View;
                if (view == null) throw new ArgumentException("No View with id " + viewId);
            }

            // ---- imports ----
            var imports = new List<ImportInstance>();
            long importId = 0;
            if (p["importId"] != null && p["importId"].Type != JTokenType.Null) importId = p["importId"].Value<long>();
            if (importId > 0)
            {
                var one = doc.GetElement(ElementQueryUtils.ToElementId(importId)) as ImportInstance;
                if (one == null) throw new ArgumentException("No ImportInstance with id " + importId);
                imports.Add(one);
            }
            else
            {
                foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(ImportInstance)))
                    imports.Add((ImportInstance)e);
            }
            if (imports.Count == 0)
                return new JObject { ["imports"] = new JArray(), ["message"] = "No ImportInstance (imported CAD) in the document." };

            if (mode == "geometry" && importId == 0 && imports.Count > 1)
            {
                var list = new JArray();
                foreach (var imp in imports) list.Add(ImportInfo(doc, imp, view));
                return new JObject
                {
                    ["imports"] = list,
                    ["message"] = "Several imports found; pass importId for mode 'geometry'."
                };
            }

            // ---- collect ----
            var all = new List<Rec>();
            var layerCache = new Dictionary<long, LayerInfo>();
            var importsJson = new JArray();
            foreach (var imp in imports)
            {
                var recs = new List<Rec>();
                var opts = new Options { ComputeReferences = false, IncludeNonVisibleObjects = false };
                if (view != null) opts.View = view;
                var ge = imp.get_Geometry(opts);
                if (ge != null)
                    Walk(doc, ge, imp.Id.GetValue(), recs, layerCache, patterns, kindSet, bbox, minLen);
                var info = ImportInfo(doc, imp, view);
                if (mode == "layers") info["layers"] = LayerSummaries(doc, recs, layerCache, view);
                importsJson.Add(info);
                all.AddRange(recs);
            }

            if (mode == "layers")
                return new JObject { ["importCount"] = imports.Count, ["objectCount"] = all.Count, ["imports"] = importsJson };

            // ---- geometry ----
            bool hasZ = false; double zMin = double.MaxValue, zMax = double.MinValue;
            foreach (var r in all)
            {
                if (r.MinZ < zMin) zMin = r.MinZ;
                if (r.MaxZ > zMax) zMax = r.MaxZ;
            }
            if (all.Count > 0 && (Math.Abs(zMin) > 0.05 || Math.Abs(zMax) > 0.05)) hasZ = true;
            bool multi = imports.Count > 1;

            var summary = LayersCounts(all);
            var result = new JObject
            {
                ["importId"] = imports[0].Id.GetValue(),
                ["total"] = all.Count,
                ["hasZ"] = hasZ,
            };
            if (all.Count > 0) result["zRange"] = new JArray(R1(zMin), R1(zMax));

            if (outFile != null)
            {
                var items = new JArray();
                foreach (var r in all) items.Add(ToJson(r, hasZ, multi));
                var full = new JObject { ["total"] = all.Count, ["hasZ"] = hasZ, ["layersSummary"] = summary, ["items"] = items };
                if (all.Count > 0) full["zRange"] = new JArray(R1(zMin), R1(zMax));
                var dir = Path.GetDirectoryName(outFile);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(outFile, full.ToString(Formatting.None));
                result["file"] = outFile;
                result["layersSummary"] = summary;
                return result;
            }

            var page = new JArray();
            int end = Math.Min(all.Count, offset + limit);
            for (int i = offset; i < end; i++) page.Add(ToJson(all[i], hasZ, multi));
            result["offset"] = offset;
            result["hasMore"] = end < all.Count;
            if (end < all.Count) result["nextOffset"] = end;
            result["layersSummary"] = summary;
            result["items"] = page;
            return result;
        }

        // ---------------- walking ----------------

        private void Walk(Document doc, GeometryElement ge, long importId, List<Rec> recs, Dictionary<long, LayerInfo> cache,
            List<string> patterns, HashSet<string> kindSet, double[] bbox, double minLen)
        {
            foreach (GeometryObject obj in ge)
            {
                if (obj is GeometryInstance gi)
                {
                    var inner = gi.GetInstanceGeometry();
                    if (inner != null) Walk(doc, inner, importId, recs, cache, patterns, kindSet, bbox, minLen);
                    continue;
                }
                Rec r = null;
                if (obj is Line ln) r = FromLine(ln);
                else if (obj is Arc arc) r = FromArc(arc);
                else if (obj is PolyLine pl) r = FromPoly(pl.GetCoordinates());
                else if (obj is Curve c) r = FromPoly(c.Tessellate()); // spline/ellipse/etc. as polyline
                else if (obj is Solid so) r = FromSolid(so);
                if (r == null) continue;

                var li = ResolveLayer(doc, obj.GraphicsStyleId, cache, patterns);
                if (!li.Match) continue;
                if (kindSet != null && !kindSet.Contains(r.Kind)) continue;
                if (bbox != null && !CadGeometryMath.BBoxIntersects(r.MinX, r.MinY, r.MaxX, r.MaxY, bbox[0], bbox[1], bbox[2], bbox[3])) continue;
                if (minLen > 0 && r.Kind != "s" && r.Length < minLen) continue;
                r.Layer = li.Name;
                r.ImportId = importId;
                recs.Add(r);
            }
        }

        private static LayerInfo ResolveLayer(Document doc, ElementId styleId, Dictionary<long, LayerInfo> cache, List<string> patterns)
        {
            long key = styleId == null ? -1 : styleId.GetValue();
            if (cache.TryGetValue(key, out var li)) return li;
            li = new LayerInfo { Name = "(no layer)" };
            if (styleId != null && styleId != ElementId.InvalidElementId)
            {
                var gs = doc.GetElement(styleId) as GraphicsStyle;
                var cat = gs?.GraphicsStyleCategory;
                if (cat != null) { li.Name = cat.Name; li.Cat = cat; }
            }
            li.Match = CadGeometryMath.LayerMatchesAny(li.Name, patterns);
            cache[key] = li;
            return li;
        }

        private static Rec FromLine(Line l)
        {
            var r = new Rec { Kind = "l" };
            var a = Mm(l.GetEndPoint(0)); var b = Mm(l.GetEndPoint(1));
            r.Pts.Add(a); r.Pts.Add(b);
            r.Grow(a[0], a[1], a[2]); r.Grow(b[0], b[1], b[2]);
            r.Length = l.Length * FtToMm;
            return r;
        }

        private static Rec FromArc(Arc a)
        {
            var r = new Rec { Kind = "a", C = Mm(a.Center), R = a.Radius * FtToMm, Full = !a.IsBound };
            if (a.IsBound) { r.Start = Mm(a.GetEndPoint(0)); r.End = Mm(a.GetEndPoint(1)); }
            foreach (var t in a.Tessellate()) { var m = Mm(t); r.Grow(m[0], m[1], m[2]); }
            if (r.Full)
            {
                r.Grow(r.C[0] - r.R, r.C[1] - r.R, r.C[2]); r.Grow(r.C[0] + r.R, r.C[1] + r.R, r.C[2]);
                r.Length = 2 * Math.PI * r.R;
            }
            else r.Length = a.Length * FtToMm;
            return r;
        }

        private static Rec FromPoly(IList<XYZ> coords)
        {
            if (coords == null || coords.Count == 0) return null;
            var r = new Rec { Kind = "p" };
            var xy = new List<(double X, double Y)>(coords.Count);
            double len = 0; double[] prev = null;
            foreach (var c in coords)
            {
                var m = Mm(c);
                r.Pts.Add(m); r.Grow(m[0], m[1], m[2]); xy.Add((m[0], m[1]));
                if (prev != null) len += Math.Sqrt((m[0] - prev[0]) * (m[0] - prev[0]) + (m[1] - prev[1]) * (m[1] - prev[1]) + (m[2] - prev[2]) * (m[2] - prev[2]));
                prev = m;
            }
            r.Length = len;
            var pm = CadGeometryMath.Measure(xy);
            r.Closed = pm.Closed; r.Area = pm.Area;
            r.Centroid = new[] { pm.CentroidX, pm.CentroidY };
            return r;
        }

        private static Rec FromSolid(Solid s)
        {
            if (s == null) return null;
            var r = new Rec { Kind = "s", Volume = s.Volume * FtToMm * FtToMm * FtToMm };
            BoundingBoxXYZ bb = null;
            try { bb = s.GetBoundingBox(); } catch { }
            if (bb != null)
            {
                foreach (var x in new[] { bb.Min.X, bb.Max.X })
                    foreach (var y in new[] { bb.Min.Y, bb.Max.Y })
                        foreach (var z in new[] { bb.Min.Z, bb.Max.Z })
                        {
                            var m = Mm(bb.Transform.OfPoint(new XYZ(x, y, z)));
                            r.Grow(m[0], m[1], m[2]);
                        }
            }
            else
            {
                foreach (Edge e in s.Edges)
                    foreach (var t in e.Tessellate()) { var m = Mm(t); r.Grow(m[0], m[1], m[2]); }
            }
            if (r.MinX > r.MaxX) return null;
            return r;
        }

        // ---------------- output ----------------

        private static JArray Xy(double[] p, bool hasZ) =>
            hasZ ? new JArray(R1(p[0]), R1(p[1]), R1(p[2])) : new JArray(R1(p[0]), R1(p[1]));

        private static JObject ToJson(Rec r, bool hasZ, bool multi)
        {
            var o = new JObject { ["k"] = r.Kind, ["layer"] = r.Layer };
            if (multi) o["importId"] = r.ImportId;
            switch (r.Kind)
            {
                case "l":
                    o["a"] = Xy(r.Pts[0], hasZ); o["b"] = Xy(r.Pts[1], hasZ);
                    break;
                case "a":
                    o["c"] = Xy(r.C, hasZ); o["r"] = R1(r.R);
                    if (r.Full) o["full"] = true;
                    else { o["start"] = Xy(r.Start, hasZ); o["end"] = Xy(r.End, hasZ); }
                    break;
                case "p":
                    var pts = new JArray();
                    foreach (var q in r.Pts) pts.Add(Xy(q, hasZ));
                    o["pts"] = pts; o["closed"] = r.Closed;
                    o["bbox"] = new JArray(R1(r.MinX), R1(r.MinY), R1(r.MaxX), R1(r.MaxY));
                    o["centroid"] = new JArray(R1(r.Centroid[0]), R1(r.Centroid[1]));
                    if (r.Closed) o["area"] = Math.Round(r.Area, 0);
                    break;
                case "s":
                    o["bbox"] = new JArray(R1(r.MinX), R1(r.MinY), R1(r.MaxX), R1(r.MaxY));
                    o["volume"] = Math.Round(r.Volume, 0);
                    break;
            }
            return o;
        }

        private static JObject LayersCounts(List<Rec> recs)
        {
            var d = new SortedDictionary<string, int[]>(StringComparer.Ordinal);
            foreach (var r in recs)
            {
                if (!d.TryGetValue(r.Layer, out var c)) d[r.Layer] = c = new int[4];
                c[KindIndex(r.Kind)]++;
            }
            var o = new JObject();
            foreach (var kv in d) o[kv.Key] = CountsJson(kv.Value);
            return o;
        }

        private static int KindIndex(string k) => k == "l" ? 0 : k == "a" ? 1 : k == "p" ? 2 : 3;

        private static JObject CountsJson(int[] c)
        {
            var o = new JObject();
            if (c[0] > 0) o["line"] = c[0];
            if (c[1] > 0) o["arc"] = c[1];
            if (c[2] > 0) o["polyline"] = c[2];
            if (c[3] > 0) o["solid"] = c[3];
            return o;
        }

        private static JArray LayerSummaries(Document doc, List<Rec> recs, Dictionary<long, LayerInfo> cache, View view)
        {
            var groups = new SortedDictionary<string, List<Rec>>(StringComparer.Ordinal);
            foreach (var r in recs)
            {
                if (!groups.TryGetValue(r.Layer, out var l)) groups[r.Layer] = l = new List<Rec>();
                l.Add(r);
            }
            var catByName = new Dictionary<string, Category>();
            foreach (var li in cache.Values) if (li.Cat != null) catByName[li.Name] = li.Cat;

            var arr = new JArray();
            foreach (var kv in groups)
            {
                var counts = new int[4];
                double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
                foreach (var r in kv.Value)
                {
                    counts[KindIndex(r.Kind)]++;
                    minX = Math.Min(minX, r.MinX); minY = Math.Min(minY, r.MinY);
                    maxX = Math.Max(maxX, r.MaxX); maxY = Math.Max(maxY, r.MaxY);
                }
                var o = new JObject
                {
                    ["name"] = kv.Key,
                    ["short"] = CadGeometryMath.ShortLayerName(kv.Key),
                    ["count"] = kv.Value.Count,
                    ["counts"] = CountsJson(counts),
                    ["bboxMm"] = new JArray(R1(minX), R1(minY), R1(maxX), R1(maxY)),
                };
                if (catByName.TryGetValue(kv.Key, out var cat))
                {
                    try
                    {
                        var col = cat.LineColor;
                        if (col != null && col.IsValid) o["color"] = new JArray(col.Red, col.Green, col.Blue);
                    }
                    catch { }
                    try { var w = cat.GetLineWeight(GraphicsStyleType.Projection); if (w.HasValue) o["lineWeight"] = w.Value; } catch { }
                    try
                    {
                        var pid = cat.GetLinePatternId(GraphicsStyleType.Projection);
                        if (pid == null || pid == ElementId.InvalidElementId) o["linePattern"] = "Solid";
                        else o["linePattern"] = doc.GetElement(pid)?.Name ?? "Unknown";
                    }
                    catch { }
                    if (view != null)
                    {
                        try { o["visibleInView"] = !view.GetCategoryHidden(cat.Id); } catch { }
                    }
                }
                arr.Add(o);
            }
            return arr;
        }

        private static JObject ImportInfo(Document doc, ImportInstance imp, View view)
        {
            var o = new JObject { ["id"] = imp.Id.GetValue() };
            string name = null;
            try { name = doc.GetElement(imp.GetTypeId())?.Name; } catch { }
            o["name"] = name ?? imp.Name;
            o["pinned"] = imp.Pinned;
            o["linked"] = imp.IsLinked;
            o["viewSpecific"] = imp.ViewSpecific;
            if (imp.OwnerViewId != null && imp.OwnerViewId != ElementId.InvalidElementId)
                o["ownerViewId"] = imp.OwnerViewId.GetValue();
            try
            {
                var t = imp.GetTotalTransform();
                var o3 = t.Origin; var bx = t.BasisX;
                o["transform"] = new JObject
                {
                    ["originMm"] = new JArray(R1(o3.X * FtToMm), R1(o3.Y * FtToMm), R1(o3.Z * FtToMm)),
                    ["basisX"] = new JArray(Math.Round(bx.X, 6), Math.Round(bx.Y, 6), Math.Round(bx.Z, 6)),
                    ["scale"] = Math.Round(bx.GetLength(), 6),
                };
            }
            catch { }
            try
            {
                var bb = imp.get_BoundingBox(null);
                if (bb != null)
                {
                    o["extentsMm"] = new JArray(R1(bb.Min.X * FtToMm), R1(bb.Min.Y * FtToMm), R1(bb.Max.X * FtToMm), R1(bb.Max.Y * FtToMm));
                    o["extentsFt"] = new JArray(Math.Round(bb.Min.X, 4), Math.Round(bb.Min.Y, 4), Math.Round(bb.Max.X, 4), Math.Round(bb.Max.Y, 4));
                }
            }
            catch { }
            if (view != null)
            {
                bool hidden = false;
                try { hidden = imp.IsHidden(view); } catch { }
                try { if (imp.Category != null && view.GetCategoryHidden(imp.Category.Id)) hidden = true; } catch { }
                o["hiddenInView"] = hidden;
            }
            return o;
        }

        private static List<string> StringList(JToken t)
        {
            if (t == null || t.Type == JTokenType.Null) return null;
            var list = new List<string>();
            if (t is JArray a) foreach (var x in a) { var s = x.ToString(); if (!string.IsNullOrWhiteSpace(s)) list.Add(s); }
            else { var s = t.ToString(); if (!string.IsNullOrWhiteSpace(s)) list.Add(s); }
            return list.Count == 0 ? null : list;
        }

        public override string GetName() => "get_cad_geometry";
    }
}
