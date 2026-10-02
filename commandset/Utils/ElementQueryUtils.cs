// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using System.Globalization;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>Shared helpers for the read-back / query commands (parsing kept local to these commands).</summary>
    public static class ElementQueryUtils
    {
        public const double FeetToMm = 304.8;

        public static double Mm(double feet) => Math.Round(feet * FeetToMm, 1);
        public static double Deg(double rad) => Math.Round(rad * 180.0 / Math.PI, 3);

        public static ElementId ToElementId(long id)
        {
#if REVIT2024_OR_GREATER
            return new ElementId(id);
#else
            return new ElementId((int)id);
#endif
        }

        public static JArray Pt(XYZ p) => new JArray(Mm(p.X), Mm(p.Y), Mm(p.Z));

        public static string GetString(JObject o, string name)
        {
            var t = o[name];
            if (t == null || t.Type == JTokenType.Null) return null;
            var s = t.ToString();
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }

        public static int GetInt(JObject o, string name, int def)
        {
            var t = o[name];
            if (t == null || t.Type == JTokenType.Null) return def;
            return int.TryParse(t.ToString(), out var v) ? v : def;
        }

        // ---------- category ----------

        public static BuiltInCategory ResolveCategory(Document doc, string name)
        {
            if (Enum.TryParse<BuiltInCategory>(name, true, out var bic) && Enum.IsDefined(typeof(BuiltInCategory), bic))
                return bic;
            if (Enum.TryParse<BuiltInCategory>("OST_" + name, true, out bic) && Enum.IsDefined(typeof(BuiltInCategory), bic))
                return bic;
            foreach (Category c in doc.Settings.Categories)
            {
                if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
                {
#if REVIT2024_OR_GREATER
                    return (BuiltInCategory)c.Id.Value;
#else
                    return (BuiltInCategory)c.Id.IntegerValue;
#endif
                }
            }
            throw new ArgumentException("Unknown category '" + name + "'. Use a BuiltInCategory name (e.g. OST_StructuralColumns) or display name.");
        }

        // ---------- names ----------

        public static ElementType GetElementType(Document doc, Element el)
        {
            var tid = el.GetTypeId();
            return tid == null || tid == ElementId.InvalidElementId ? null : doc.GetElement(tid) as ElementType;
        }

        public static string FamilyName(Document doc, Element el) => GetElementType(doc, el)?.FamilyName;
        public static string TypeName(Document doc, Element el) => GetElementType(doc, el)?.Name ?? el.Name;

        public static Parameter Param(Element el, BuiltInParameter bip)
        {
            try { return el?.get_Parameter(bip); } catch { return null; }
        }

        public static Level GetLevel(Document doc, Element el)
        {
            try
            {
                if (el.LevelId != null && el.LevelId != ElementId.InvalidElementId && doc.GetElement(el.LevelId) is Level l)
                    return l;
            }
            catch { }
            foreach (var bip in new[] {
                BuiltInParameter.SCHEDULE_LEVEL_PARAM, BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
                BuiltInParameter.FAMILY_LEVEL_PARAM, BuiltInParameter.FAMILY_BASE_LEVEL_PARAM })
            {
                var p = Param(el, bip);
                if (p != null && p.HasValue && p.StorageType == StorageType.ElementId && doc.GetElement(p.AsElementId()) is Level pl)
                    return pl;
            }
            return null;
        }

        // ---------- parameter values (for filters) ----------

        public sealed class ResolvedValue
        {
            public string Text;
            public double? Num;
        }

        private static bool IsLength(Parameter p)
        {
            try
            {
#if REVIT2022_OR_GREATER
                return p.Definition.GetDataType() == SpecTypeId.Length;
#else
                return p.Definition.ParameterType == ParameterType.Length;
#endif
            }
            catch { return false; }
        }

        private static ResolvedValue FromParameter(Parameter p)
        {
            if (p == null || !p.HasValue) return new ResolvedValue();
            string text = null;
            double? num = null;
            switch (p.StorageType)
            {
                case StorageType.String: text = p.AsString(); break;
                case StorageType.Integer:
                    num = p.AsInteger();
                    try { text = p.AsValueString(); } catch { }
                    if (string.IsNullOrEmpty(text)) text = p.AsInteger().ToString(CultureInfo.InvariantCulture);
                    break;
                case StorageType.Double:
                    num = IsLength(p) ? p.AsDouble() * FeetToMm : p.AsDouble();
                    try { text = p.AsValueString(); } catch { }
                    if (string.IsNullOrEmpty(text)) text = num.Value.ToString(CultureInfo.InvariantCulture);
                    break;
                case StorageType.ElementId:
                    try { text = p.AsValueString(); } catch { }
                    break;
            }
            return new ResolvedValue { Text = text, Num = num };
        }

        /// <summary>scope: auto (instance, then type) | instance | type. Returns null when the parameter does not exist.</summary>
        public static ResolvedValue ResolveParameter(Document doc, Element el, string name, string scope)
        {
            if (string.Equals(name, "SourceKey", StringComparison.OrdinalIgnoreCase) && scope != "type")
                return new ResolvedValue { Text = SourceKeyStore.Read(el) };
            if (scope == "instance" || scope == "auto")
            {
                var p = el.LookupParameter(name);
                if (p != null) return FromParameter(p);
            }
            if (scope == "type" || scope == "auto")
            {
                var t = GetElementType(doc, el);
                var p = t?.LookupParameter(name);
                if (p != null) return FromParameter(p);
            }
            return null;
        }

        public sealed class ParamFilter
        {
            public string Name, Op, Scope, Value;
            public double? NumValue;
        }

        private static readonly string[] SupportedOps =
            { "eq", "neq", "contains", "gt", "lt", "gte", "lte", "is_empty", "not_empty", "starts_with" };

        public static List<ParamFilter> ParseFilters(JToken arr, string defaultScope)
        {
            var list = new List<ParamFilter>();
            if (arr == null || arr.Type != JTokenType.Array) return list;
            foreach (var t in (JArray)arr)
            {
                if (!(t is JObject o)) continue;
                var name = GetString(o, "name") ?? GetString(o, "parameter");
                if (name == null) throw new ArgumentException("parameterFilters item missing 'name'.");
                var op = (GetString(o, "op") ?? GetString(o, "operator") ?? "eq").ToLowerInvariant();
                switch (op)
                {
                    case "=": case "==": case "equals": op = "eq"; break;
                    case "!=": case "<>": op = "neq"; break;
                    case ">": op = "gt"; break;
                    case "<": op = "lt"; break;
                    case ">=": op = "gte"; break;
                    case "<=": op = "lte"; break;
                }
                if (!SupportedOps.Contains(op))
                    throw new ArgumentException("Unsupported op '" + op + "'. Use eq|neq|contains|gt|lt|is_empty.");
                var scope = (GetString(o, "scope") ?? defaultScope ?? "auto").ToLowerInvariant();
                if (scope != "auto" && scope != "instance" && scope != "type")
                    throw new ArgumentException("scope must be instance|type.");
                var val = o["value"] == null || o["value"].Type == JTokenType.Null ? null : o["value"].ToString();
                double? num = null;
                if (val != null && double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) num = d;
                list.Add(new ParamFilter { Name = name, Op = op, Scope = scope, Value = val, NumValue = num });
            }
            return list;
        }

        public static bool Matches(Document doc, Element el, ParamFilter f)
        {
            var rv = ResolveParameter(doc, el, f.Name, f.Scope);
            var text = rv?.Text;
            switch (f.Op)
            {
                case "is_empty": return string.IsNullOrWhiteSpace(text) && rv?.Num == null;
                case "not_empty": return !string.IsNullOrWhiteSpace(text) || rv?.Num != null;
            }
            if (rv == null || (text == null && rv.Num == null)) return false;
            var v = f.Value ?? "";
            switch (f.Op)
            {
                case "eq":
                    if (rv.Num.HasValue && f.NumValue.HasValue) return Math.Abs(rv.Num.Value - f.NumValue.Value) < 0.01;
                    return string.Equals(text, v, StringComparison.OrdinalIgnoreCase);
                case "neq":
                    if (rv.Num.HasValue && f.NumValue.HasValue) return Math.Abs(rv.Num.Value - f.NumValue.Value) >= 0.01;
                    return !string.Equals(text, v, StringComparison.OrdinalIgnoreCase);
                case "contains": return text != null && text.IndexOf(v, StringComparison.OrdinalIgnoreCase) >= 0;
                case "starts_with": return text != null && text.StartsWith(v, StringComparison.OrdinalIgnoreCase);
                case "gt": return rv.Num.HasValue && f.NumValue.HasValue && rv.Num.Value > f.NumValue.Value;
                case "lt": return rv.Num.HasValue && f.NumValue.HasValue && rv.Num.Value < f.NumValue.Value;
                case "gte": return rv.Num.HasValue && f.NumValue.HasValue && rv.Num.Value >= f.NumValue.Value;
                case "lte": return rv.Num.HasValue && f.NumValue.HasValue && rv.Num.Value <= f.NumValue.Value;
            }
            return false;
        }

        // ---------- element filter spec (shared by find_elements / query_where) ----------

        public sealed class FilterSpec
        {
            public string Category, TypeName, FamilyName, LevelName, SourceKeyPrefix;
            public long ViewId;
            public List<ParamFilter> Filters = new List<ParamFilter>();

            public static FilterSpec Parse(JObject p, string defaultScope)
            {
                var s = new FilterSpec
                {
                    Category = GetString(p, "category"),
                    TypeName = GetString(p, "typeName"),
                    FamilyName = GetString(p, "familyName"),
                    LevelName = GetString(p, "levelName"),
                    SourceKeyPrefix = GetString(p, "sourceKeyPrefix"),
                    ViewId = p["viewId"] != null && p["viewId"].Type != JTokenType.Null ? p["viewId"].Value<long>() : 0,
                };
                s.Filters = ParseFilters(p["parameterFilters"] ?? p["where"], defaultScope);
                if (s.Category == null && s.SourceKeyPrefix == null && s.ViewId == 0)
                    throw new ArgumentException("Provide at least one of: category, sourceKeyPrefix, viewId.");
                return s;
            }

            public IEnumerable<Element> Collect(Document doc)
            {
                FilteredElementCollector col = ViewId != 0
                    ? new FilteredElementCollector(doc, ToElementId(ViewId))
                    : new FilteredElementCollector(doc);
                IList<Element> src;
                if (Category != null)
                    src = col.OfCategory(ResolveCategory(doc, Category)).WhereElementIsNotElementType().ToElements();
                else if (SourceKeyPrefix != null)
                    src = col.WherePasses(new Autodesk.Revit.DB.ExtensibleStorage.ExtensibleStorageFilter(SourceKeyStore.SchemaGuid)).ToElements();
                else
                    src = col.WhereElementIsNotElementType().ToElements();
                return src.OrderBy(e => e.Id.GetValue());
            }

            public bool Match(Document doc, Element el)
            {
                if (TypeName != null)
                {
                    var tn = ElementQueryUtils.TypeName(doc, el);
                    if (tn == null || tn.IndexOf(TypeName, StringComparison.OrdinalIgnoreCase) < 0) return false;
                }
                if (FamilyName != null)
                {
                    var fn = ElementQueryUtils.FamilyName(doc, el);
                    if (fn == null || fn.IndexOf(FamilyName, StringComparison.OrdinalIgnoreCase) < 0) return false;
                }
                if (LevelName != null)
                {
                    var l = GetLevel(doc, el);
                    if (l == null || !string.Equals(l.Name, LevelName, StringComparison.OrdinalIgnoreCase)) return false;
                }
                if (SourceKeyPrefix != null)
                {
                    var k = SourceKeyStore.Read(el);
                    if (k == null || !k.StartsWith(SourceKeyPrefix, StringComparison.Ordinal)) return false;
                }
                foreach (var f in Filters)
                    if (!ElementQueryUtils.Matches(doc, el, f)) return false;
                return true;
            }
        }

        // ---------- element info ----------

        public static readonly string[] AllFields = {
            "uniqueId", "category", "family", "type", "typeId", "level", "location", "bbox",
            "elevations", "offsets", "material", "comments", "mark", "sourceKey" };

        public static readonly string[] DefaultFindFields = { "type", "location" };

        public static HashSet<string> ParseFields(JToken t, string[] defaults)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var arr = t as JArray;
            if (arr == null || arr.Count == 0) { foreach (var d in defaults) set.Add(d); return set; }
            foreach (var x in arr) set.Add(x.ToString());
            return set;
        }

        private static void AddLenParam(JObject o, string key, Element el, BuiltInParameter bip)
        {
            var p = Param(el, bip);
            if (p != null && p.HasValue && p.StorageType == StorageType.Double) o[key] = Mm(p.AsDouble());
        }

        private static void AddTextParam(JObject o, string key, Element el, BuiltInParameter bip)
        {
            var p = Param(el, bip);
            if (p == null || !p.HasValue) return;
            string s = null;
            try { s = p.AsValueString(); } catch { }
            if (string.IsNullOrEmpty(s) && p.StorageType == StorageType.String) s = p.AsString();
            if (!string.IsNullOrEmpty(s)) o[key] = s;
        }

        public static JObject BuildInfo(Document doc, Element el, HashSet<string> fields)
        {
            bool Want(string f) => fields.Contains(f);
            var o = new JObject();
            o["id"] = el.Id.GetValue();
            if (Want("uniqueId")) o["uniqueId"] = el.UniqueId;
            if (Want("category")) o["category"] = el.Category?.Name;
            if (Want("family")) o["family"] = FamilyName(doc, el);
            if (Want("type")) o["type"] = TypeName(doc, el);
            if (Want("typeId")) o["typeId"] = el.GetTypeId()?.GetValue();
            if (Want("level"))
            {
                var l = GetLevel(doc, el);
                if (l != null) { o["levelName"] = l.Name; o["levelElevation"] = Mm(l.Elevation); }
            }
            if (Want("location"))
            {
                var loc = el.Location;
                if (loc is LocationPoint lp)
                    o["location"] = new JObject { ["point"] = Pt(lp.Point), ["rotationDeg"] = Deg(lp.Rotation) };
                else if (loc is LocationCurve lc && lc.Curve != null && lc.Curve.IsBound)
                    o["location"] = new JObject { ["start"] = Pt(lc.Curve.GetEndPoint(0)), ["end"] = Pt(lc.Curve.GetEndPoint(1)) };
            }
            BoundingBoxXYZ bb = null;
            if (Want("bbox") || Want("elevations"))
            {
                try { bb = el.get_BoundingBox(null); } catch { }
            }
            if (Want("bbox") && bb != null)
                o["bbox"] = new JObject { ["min"] = Pt(bb.Min), ["max"] = Pt(bb.Max) };
            if (Want("elevations") && bb != null)
            {
                o["topElevation"] = Mm(bb.Max.Z);
                o["bottomElevation"] = Mm(bb.Min.Z);
            }
            if (Want("offsets"))
            {
                var off = new JObject();
                AddTextParam(off, "baseLevel", el, BuiltInParameter.FAMILY_BASE_LEVEL_PARAM);
                AddLenParam(off, "baseOffset", el, BuiltInParameter.FAMILY_BASE_LEVEL_OFFSET_PARAM);
                AddTextParam(off, "topLevel", el, BuiltInParameter.FAMILY_TOP_LEVEL_PARAM);
                AddLenParam(off, "topOffset", el, BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM);
                AddLenParam(off, "hostOffset", el, BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM);
                AddTextParam(off, "referenceLevel", el, BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM);
                AddTextParam(off, "zJustification", el, BuiltInParameter.Z_JUSTIFICATION);
                AddLenParam(off, "zOffset", el, BuiltInParameter.Z_OFFSET_VALUE);
                AddLenParam(off, "startZOffset", el, BuiltInParameter.STRUCTURAL_BEAM_END0_ELEVATION);
                AddLenParam(off, "endZOffset", el, BuiltInParameter.STRUCTURAL_BEAM_END1_ELEVATION);
                if (off.Count > 0) o["offsets"] = off;
            }
            if (Want("material"))
            {
                string mat = null;
                var p = Param(el, BuiltInParameter.STRUCTURAL_MATERIAL_PARAM);
                if (p == null || !p.HasValue || p.AsElementId() == ElementId.InvalidElementId)
                    p = Param(GetElementType(doc, el), BuiltInParameter.STRUCTURAL_MATERIAL_PARAM);
                if (p != null && p.HasValue && p.StorageType == StorageType.ElementId)
                    mat = (doc.GetElement(p.AsElementId()) as Material)?.Name;
                if (mat != null) o["material"] = mat;
            }
            if (Want("comments")) AddTextParam(o, "comments", el, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
            if (Want("mark")) AddTextParam(o, "mark", el, BuiltInParameter.ALL_MODEL_MARK);
            if (Want("sourceKey"))
            {
                var k = SourceKeyStore.Read(el);
                if (k != null) o["sourceKey"] = k;
            }
            return o;
        }
    }
}
