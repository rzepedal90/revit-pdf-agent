// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>Plain 2D point in millimetres.</summary>
    public struct MmPoint
    {
        public double X, Y;
        public MmPoint(double x, double y) { X = x; Y = y; }
    }

    public sealed class ParamSpec
    {
        public string Name;
        public string BuiltIn;
        public JToken Value;
        public string Units;
    }

    /// <summary>One validated element request. XY values are already transformed to model coordinates (mm).</summary>
    public sealed class BuildItemSpec
    {
        public string SourceKey;
        public string Kind;
        public long? TypeId;
        public string FamilyName;
        public string TypeName;

        public MmPoint Point;            // footing, column
        public MmPoint Start, End;       // beam, wall, grid
        public double RotationDeg;       // footing, column (includes transform rotation), normalised to [0,360)

        public string Level;             // footing, beam
        public double OffsetMm;          // footing
        public string BaseLevel;         // column, wall
        public double BaseOffsetMm;
        public string TopLevel;          // column, wall (optional for wall)
        public double TopOffsetMm;
        public double? HeightMm;         // wall unconnected height
        public double StartOffsetMm, EndOffsetMm; // beam
        public string ZJustification;    // top|center|bottom
        public string StructuralUsage;   // girder|joist|other|null
        public bool Structural = true;   // wall
        public string LocationLine = "center"; // wall
        public string GridName;          // grid
        public List<List<MmPoint>> Boundary; // floor: outer loop first, then holes (model mm, cleaned, implicitly closed)
        public List<ParamSpec> Parameters = new List<ParamSpec>();
    }

    public sealed class BuildSpec
    {
        public const int MaxElements = 500;
        public bool DryRun = true;
        /// <summary>XY readback tolerance (mm) for placed locations; Revit wall auto-join can nudge ends by a few mm.</summary>
        public double ReadbackToleranceMm = BuildElementsModel.MmTolerance;
        public string Mode = "upsert";
        public string ManifestHash;
        public List<BuildItemSpec> Items = new List<BuildItemSpec>();
    }

    /// <summary>Pure (Revit-independent) payload validation, transform and tolerance helpers for build_elements.</summary>
    public static class BuildElementsModel
    {
        public const double MmTolerance = 0.5;
        public const double AngleToleranceDeg = 0.01;
        public const double MmPerFt = 304.8;

        public static readonly string[] Kinds = { "footing", "column", "beam", "wall", "grid", "floor" };
        public static readonly string[] ZJustifications = { "top", "center", "bottom" };
        public static readonly string[] StructuralUsages = { "girder", "joist", "other" };
        public static readonly string[] LocationLines =
            { "center", "core_center", "finish_exterior", "finish_interior", "core_exterior", "core_interior" };

        public static double MmToFt(double mm) => mm / MmPerFt;
        public static double FtToMm(double ft) => ft * MmPerFt;

        public static bool NearMm(double aMm, double bMm, double tol = MmTolerance) => Math.Abs(aMm - bMm) <= tol;

        public static double NormalizeDeg(double deg)
        {
            var d = deg % 360.0;
            return d < 0 ? d + 360.0 : d;
        }

        /// <summary>Smallest absolute difference between two angles in degrees, in [0,180].</summary>
        public static double AngleDiffDeg(double a, double b)
        {
            var d = Math.Abs(NormalizeDeg(a) - NormalizeDeg(b));
            return d > 180.0 ? 360.0 - d : d;
        }

        /// <summary>model = origin + R(rotationDeg) * p (counter-clockwise).</summary>
        public static MmPoint ApplyTransform(MmPoint p, double ox, double oy, double rotDeg)
        {
            var r = rotDeg * Math.PI / 180.0;
            var c = Math.Cos(r);
            var s = Math.Sin(r);
            return new MmPoint(ox + c * p.X - s * p.Y, oy + s * p.X + c * p.Y);
        }

        public static BuildSpec Parse(JObject p)
        {
            if (p == null) throw Bad("Request body is required.");
            var spec = new BuildSpec
            {
                DryRun = ParamUtil.BoolOr(p, "dryRun", true),
                Mode = (ParamUtil.StrOrNull(p, "mode") ?? "upsert").Trim().ToLowerInvariant(),
                ManifestHash = ParamUtil.StrOrNull(p, "manifestHash"),
            };
            var tolTok = p["readbackToleranceMm"];
            if (tolTok != null && tolTok.Type != JTokenType.Null)
            {
                var tol = tolTok.Value<double>();
                if (!(tol >= 0 && tol <= 100)) throw Bad("Parameter 'readbackToleranceMm' must be between 0 and 100 mm.");
                spec.ReadbackToleranceMm = Math.Max(tol, MmTolerance);
            }
            if (spec.Mode != "upsert" && spec.Mode != "create_only")
                throw Bad("Parameter 'mode' must be 'upsert' or 'create_only', got '" + spec.Mode + "'.");

            double ox = 0, oy = 0, rot = 0;
            var tr = p["transform"];
            if (tr != null && tr.Type != JTokenType.Null)
            {
                var to = tr as JObject ?? throw Bad("Parameter 'transform' must be an object.");
                var origin = ParamUtil.AnyOrNull(to, "originMm");
                if (origin != null)
                {
                    var oo = origin as JObject ?? throw Bad("Parameter 'transform.originMm' must be an object {x,y}.");
                    ox = ParamUtil.Dbl(oo, "x");
                    oy = ParamUtil.Dbl(oo, "y");
                }
                rot = ParamUtil.DblOr(to, "rotationDeg", 0);
            }

            var elements = ParamUtil.Arr(p, "elements");
            if (elements.Count > BuildSpec.MaxElements)
                throw Bad("At most " + BuildSpec.MaxElements + " elements per call, got " + elements.Count + ".");

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < elements.Count; i++)
            {
                var jo = elements[i] as JObject ?? throw Bad("elements[" + i + "] must be an object.");
                BuildItemSpec item;
                try { item = ParseItem(jo, ox, oy, rot); }
                catch (RevitCommandException ex)
                {
                    var key = jo["sourceKey"]?.Type == JTokenType.String ? (string)jo["sourceKey"] : "#" + i;
                    throw new RevitCommandException(ex.Code, "elements[" + i + "] (" + key + "): " + ex.Detail);
                }
                if (!seen.Add(item.SourceKey))
                    throw Bad("Duplicate sourceKey '" + item.SourceKey + "' in request (elements[" + i + "]).");
                spec.Items.Add(item);
            }
            return spec;
        }

        private static RevitCommandException Bad(string msg) => new RevitCommandException(ErrorCodes.InvalidParameter, msg);

        private static MmPoint Pt(JObject o, string key, double ox, double oy, double rot)
        {
            var po = ParamUtil.Obj(o, key);
            var raw = new MmPoint(ParamUtil.Dbl(po, "x"), ParamUtil.Dbl(po, "y"));
            return ApplyTransform(raw, ox, oy, rot);
        }

        private static string Choice(JObject o, string key, string[] allowed, string dflt)
        {
            var v = ParamUtil.StrOrNull(o, key);
            if (v == null)
            {
                if (dflt == null) throw Bad("Missing required parameter '" + key + "'.");
                return dflt;
            }
            v = v.Trim().ToLowerInvariant();
            if (Array.IndexOf(allowed, v) < 0)
                throw Bad("Parameter '" + key + "' must be one of " + string.Join("|", allowed) + ", got '" + v + "'.");
            return v;
        }

        private static string Req(JObject o, string key)
        {
            var s = ParamUtil.Str(o, key);
            if (string.IsNullOrWhiteSpace(s)) throw Bad("Parameter '" + key + "' must not be empty.");
            return s;
        }

        public static BuildItemSpec ParseItem(JObject o, double ox, double oy, double rot)
        {
            var it = new BuildItemSpec { SourceKey = Req(o, "sourceKey") };
            it.Kind = Choice(o, "kind", Kinds, null);

            if (it.Kind != "grid")
            {
                it.TypeId = ParamUtil.LongOrNull(o, "typeId");
                it.FamilyName = ParamUtil.StrOrNull(o, "familyName");
                it.TypeName = ParamUtil.StrOrNull(o, "typeName");
                if (it.TypeId == null && string.IsNullOrWhiteSpace(it.TypeName))
                    throw Bad("Either 'typeId' or 'typeName' (with optional 'familyName') is required for kind '" + it.Kind + "'.");
            }

            switch (it.Kind)
            {
                case "footing":
                    it.Point = Pt(o, "point", ox, oy, rot);
                    it.RotationDeg = NormalizeDeg(ParamUtil.Dbl(o, "rotationDeg") + rot);
                    it.Level = Req(o, "level");
                    it.OffsetMm = ParamUtil.Dbl(o, "offsetMm");
                    break;
                case "column":
                    it.Point = Pt(o, "point", ox, oy, rot);
                    it.RotationDeg = NormalizeDeg(ParamUtil.Dbl(o, "rotationDeg") + rot);
                    it.BaseLevel = Req(o, "baseLevel");
                    it.BaseOffsetMm = ParamUtil.Dbl(o, "baseOffsetMm");
                    it.TopLevel = Req(o, "topLevel");
                    it.TopOffsetMm = ParamUtil.Dbl(o, "topOffsetMm");
                    break;
                case "beam":
                    it.Start = Pt(o, "start", ox, oy, rot);
                    it.End = Pt(o, "end", ox, oy, rot);
                    it.Level = Req(o, "level");
                    it.StartOffsetMm = ParamUtil.Dbl(o, "startOffsetMm");
                    it.EndOffsetMm = ParamUtil.Dbl(o, "endOffsetMm");
                    it.ZJustification = Choice(o, "zJustification", ZJustifications, "top");
                    if (ParamUtil.StrOrNull(o, "structuralUsage") != null)
                        it.StructuralUsage = Choice(o, "structuralUsage", StructuralUsages, null);
                    RequireNonDegenerate(it);
                    break;
                case "wall":
                    it.Start = Pt(o, "start", ox, oy, rot);
                    it.End = Pt(o, "end", ox, oy, rot);
                    it.BaseLevel = Req(o, "baseLevel");
                    it.BaseOffsetMm = ParamUtil.Dbl(o, "baseOffsetMm");
                    it.Structural = ParamUtil.BoolOr(o, "structural", true);
                    it.LocationLine = ParseLocationLine(ParamUtil.StrOrNull(o, "locationLine"));
                    var top = ParamUtil.StrOrNull(o, "topLevel");
                    var h = ParamUtil.AnyOrNull(o, "heightMm");
                    if (!string.IsNullOrWhiteSpace(top))
                    {
                        if (h != null) throw Bad("Give either 'topLevel'+'topOffsetMm' or 'heightMm', not both.");
                        it.TopLevel = top;
                        it.TopOffsetMm = ParamUtil.Dbl(o, "topOffsetMm");
                    }
                    else
                    {
                        if (h == null) throw Bad("Wall needs 'topLevel'+'topOffsetMm' or 'heightMm'.");
                        var hv = ParamUtil.AsDouble(h, "heightMm");
                        if (hv <= 0) throw Bad("Parameter 'heightMm' must be > 0.");
                        it.HeightMm = hv;
                    }
                    RequireNonDegenerate(it);
                    break;
                case "floor":
                    it.Level = Req(o, "level");
                    it.OffsetMm = ParamUtil.Dbl(o, "offsetMm");
                    it.Structural = ParamUtil.BoolOr(o, "structural", false);
                    it.Boundary = ParseBoundary(o, ox, oy, rot);
                    break;
                case "grid":
                    it.GridName = Req(o, "name");
                    it.Start = Pt(o, "start", ox, oy, rot);
                    it.End = Pt(o, "end", ox, oy, rot);
                    RequireNonDegenerate(it);
                    break;
            }

            var pa = ParamUtil.ArrOrNull(o, "parameters");
            if (pa != null)
            {
                for (int i = 0; i < pa.Count; i++)
                {
                    var po = pa[i] as JObject ?? throw Bad("parameters[" + i + "] must be an object.");
                    var ps = new ParamSpec
                    {
                        Name = ParamUtil.StrOrNull(po, "name"),
                        BuiltIn = ParamUtil.StrOrNull(po, "builtIn"),
                        Value = ParamUtil.Any(po, "value"),
                        Units = ParamUtil.StrOrNull(po, "units"),
                    };
                    if (string.IsNullOrWhiteSpace(ps.Name) && string.IsNullOrWhiteSpace(ps.BuiltIn))
                        throw Bad("parameters[" + i + "] needs 'name' or 'builtIn'.");
                    it.Parameters.Add(ps);
                }
            }
            return it;
        }

        /// <summary>Accepts snake_case, camelCase and Revit enum spellings; returns the canonical snake_case option.</summary>
        public static string ParseLocationLine(string raw)
        {
            if (raw == null) return "center";
            var k = raw.Trim().ToLowerInvariant().Replace("_", "").Replace("-", "").Replace(" ", "");
            switch (k)
            {
                case "center": case "wallcenterline": case "centerline": return "center";
                case "corecenter": case "corecenterline": return "core_center";
                case "finishexterior": case "finishfaceexterior": return "finish_exterior";
                case "finishinterior": case "finishfaceinterior": return "finish_interior";
                case "coreexterior": return "core_exterior";
                case "coreinterior": return "core_interior";
            }
            throw Bad("Parameter 'locationLine' must be one of " + string.Join("|", LocationLines) + " (camelCase like finishFaceExterior also accepted), got '" + raw + "'.");
        }

        public const double MinSegmentMm = 1.0;

        private static List<List<MmPoint>> ParseBoundary(JObject o, double ox, double oy, double rot)
        {
            var loops = ParamUtil.Arr(o, "boundary");
            if (loops.Count == 0) throw Bad("'boundary' needs at least one loop (outer loop first).");
            var result = new List<List<MmPoint>>();
            for (int li = 0; li < loops.Count; li++)
            {
                var la = loops[li] as JArray ?? throw Bad("boundary[" + li + "] must be an array of {x,y} points.");
                var pts = new List<MmPoint>();
                for (int pi = 0; pi < la.Count; pi++)
                {
                    var po = la[pi] as JObject ?? throw Bad("boundary[" + li + "][" + pi + "] must be an object {x,y}.");
                    pts.Add(ApplyTransform(new MmPoint(ParamUtil.Dbl(po, "x"), ParamUtil.Dbl(po, "y")), ox, oy, rot));
                }
                var clean = CleanLoop(pts);
                if (clean.Count < 3)
                    throw Bad("boundary[" + li + "] has " + clean.Count + " distinct points after removing segments < " + MinSegmentMm + " mm; at least 3 are required.");
                if (Math.Abs(SignedAreaMm2(clean)) < 1.0)
                    throw Bad("boundary[" + li + "] is degenerate (area < 1 mm2, points collinear?).");
                result.Add(clean);
            }
            return result;
        }

        /// <summary>Removes consecutive points closer than MinSegmentMm (including a repeated closing point).</summary>
        public static List<MmPoint> CleanLoop(IList<MmPoint> pts)
        {
            var r = new List<MmPoint>();
            foreach (var p in pts)
                if (r.Count == 0 || Dist(r[r.Count - 1], p) >= MinSegmentMm) r.Add(p);
            while (r.Count > 1 && Dist(r[r.Count - 1], r[0]) < MinSegmentMm) r.RemoveAt(r.Count - 1);
            return r;
        }

        public static double Dist(MmPoint a, MmPoint b)
        {
            var dx = a.X - b.X; var dy = a.Y - b.Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        public static double SignedAreaMm2(IList<MmPoint> pts)
        {
            double a = 0;
            for (int i = 0; i < pts.Count; i++)
            {
                var p = pts[i]; var q = pts[(i + 1) % pts.Count];
                a += p.X * q.Y - q.X * p.Y;
            }
            return a / 2.0;
        }

        /// <summary>Axis-aligned extent {minX,minY,maxX,maxY} of a loop.</summary>
        public static double[] Extent(IList<MmPoint> pts)
        {
            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
            foreach (var p in pts) { x0 = Math.Min(x0, p.X); y0 = Math.Min(y0, p.Y); x1 = Math.Max(x1, p.X); y1 = Math.Max(y1, p.Y); }
            return new[] { x0, y0, x1, y1 };
        }

        /// <summary>True when both loops have the same vertex set within tol (order/start/direction independent).</summary>
        public static bool LoopsEqual(IList<MmPoint> a, IList<MmPoint> b, double tol = MmTolerance)
        {
            if (a.Count != b.Count) return false;
            var used = new bool[b.Count];
            foreach (var p in a)
            {
                bool hit = false;
                for (int j = 0; j < b.Count; j++)
                    if (!used[j] && Dist(p, b[j]) <= tol) { used[j] = true; hit = true; break; }
                if (!hit) return false;
            }
            return true;
        }

        /// <summary>True when both loop collections match loop-for-loop (any order) within tol.</summary>
        public static bool BoundariesEqual(IList<List<MmPoint>> want, IList<List<MmPoint>> actual, double tol = MmTolerance)
        {
            if (want.Count != actual.Count) return false;
            var used = new bool[actual.Count];
            foreach (var w in want)
            {
                bool hit = false;
                for (int j = 0; j < actual.Count; j++)
                    if (!used[j] && LoopsEqual(w, actual[j], tol)) { used[j] = true; hit = true; break; }
                if (!hit) return false;
            }
            return true;
        }

        private static void RequireNonDegenerate(BuildItemSpec it)
        {
            var dx = it.End.X - it.Start.X;
            var dy = it.End.Y - it.Start.Y;
            if (Math.Sqrt(dx * dx + dy * dy) < 1.0)
                throw Bad("start and end coincide (length < 1 mm).");
        }

        /// <summary>Revit Z_JUSTIFICATION integer value (0 top, 1 center, 2 origin, 3 bottom).</summary>
        public static int ZJustificationValue(string z)
        {
            switch (z) { case "top": return 0; case "center": return 1; case "bottom": return 3; }
            throw Bad("Unknown zJustification '" + z + "'.");
        }

        /// <summary>Revit WALL_KEY_REF_PARAM integer value.</summary>
        public static int LocationLineValue(string l)
        {
            switch (l)
            {
                case "center": return 0;
                case "core_center": return 1;
                case "finish_exterior": return 2;
                case "finish_interior": return 3;
                case "core_exterior": return 4;
                case "core_interior": return 5;
            }
            throw Bad("Unknown locationLine '" + l + "'.");
        }
    }
}
