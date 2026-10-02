// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>A coerced, not-yet-applied parameter write (expected value held in storage-native form).</summary>
    public sealed class PlannedWrite
    {
        public Parameter Param;
        public string Label;
        public StorageType Storage;
        public string S;
        public int I;
        public double D;     // internal units
        public long E;
        public JObject Before;
    }

    /// <summary>Verified parameter writes shared by set_parameter, set_parameter_batch and duplicate_family_type.</summary>
    public static class ParameterWriter
    {
        public static ElementId MakeId(long v)
        {
#if REVIT2024_OR_GREATER
            return new ElementId(v);
#else
            return new ElementId((int)v);
#endif
        }

        /// <summary>Resolves the element that owns the parameter: the element itself (instance) or its type (type).</summary>
        public static Element ResolveOwner(Document doc, long elementId, string scope)
        {
            var el = doc.GetElement(MakeId(elementId))
                ?? throw new RevitCommandException(ErrorCodes.NotFound, "No element with id " + elementId + ".");
            var s = (scope ?? "instance").Trim().ToLowerInvariant();
            if (s == "instance") return el;
            if (s != "type")
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Parameter 'scope' must be 'instance' or 'type', got '" + scope + "'.");
            if (el is ElementType) return el;
            var typeId = el.GetTypeId();
            var type = typeId == null || typeId == ElementId.InvalidElementId ? null : doc.GetElement(typeId);
            return type ?? throw new RevitCommandException(ErrorCodes.NotFound, "Element " + elementId + " has no type element.");
        }

        public static Parameter Lookup(Element owner, string name, string builtIn)
        {
            if (!string.IsNullOrWhiteSpace(builtIn))
            {
                if (!Enum.TryParse(builtIn.Trim(), false, out BuiltInParameter bip))
                    throw new RevitCommandException(ErrorCodes.InvalidParameter, "Unknown BuiltInParameter '" + builtIn + "'.");
                return owner.get_Parameter(bip)
                    ?? throw new RevitCommandException(ErrorCodes.NotFound, "Element " + owner.Id.GetValue() + " has no built-in parameter " + builtIn + ".");
            }
            if (string.IsNullOrWhiteSpace(name))
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Either 'name' or 'builtIn' is required.");
            return owner.LookupParameter(name)
                ?? throw new RevitCommandException(ErrorCodes.NotFound, "Element " + owner.Id.GetValue() + " has no parameter named '" + name + "'.");
        }

        private static UnitSpec Classify(Parameter p)
        {
#if REVIT2022_OR_GREATER
            var dt = p.Definition.GetDataType();
            if (!UnitUtils.IsMeasurableSpec(dt)) return UnitSpec.Dimensionless;
            if (dt == SpecTypeId.Length) return UnitSpec.Length;
            if (dt == SpecTypeId.Area) return UnitSpec.Area;
            if (dt == SpecTypeId.Volume) return UnitSpec.Volume;
            return UnitSpec.Other;
#else
            switch (p.Definition.ParameterType)
            {
                case ParameterType.Length: return UnitSpec.Length;
                case ParameterType.Area: return UnitSpec.Area;
                case ParameterType.Volume: return UnitSpec.Volume;
                case ParameterType.Number:
                case ParameterType.Integer:
                case ParameterType.Text:
                case ParameterType.MultilineText:
                case ParameterType.YesNo:
                case ParameterType.URL:
                case ParameterType.Material:
                case ParameterType.FamilyType:
                case ParameterType.LoadClassification:
                case ParameterType.Invalid:
                    return UnitSpec.Dimensionless;
                default:
                    return UnitSpec.Other;
            }
#endif
        }

        public static JObject Snapshot(Parameter p)
        {
            string display = null;
            try { display = p.AsValueString(); } catch { }
            object raw;
            switch (p.StorageType)
            {
                case StorageType.String: raw = p.AsString(); if (display == null) display = (string)raw; break;
                case StorageType.Integer: raw = p.AsInteger(); break;
                case StorageType.Double: raw = p.AsDouble(); break;
                case StorageType.ElementId: raw = p.AsElementId().GetValue(); break;
                default: raw = null; break;
            }
            return new JObject { ["display"] = display, ["raw"] = raw == null ? JValue.CreateNull() : new JValue(raw) };
        }

        /// <summary>Coerces <paramref name="value"/> for the parameter's storage type and units. Does not write.</summary>
        public static PlannedWrite Plan(Parameter p, string label, JToken value, string units)
        {
            if (p.IsReadOnly)
                throw new RevitCommandException(ErrorCodes.RevitError, "Parameter '" + label + "' is read-only.");

            var w = new PlannedWrite { Param = p, Label = label, Storage = p.StorageType, Before = Snapshot(p) };
            switch (p.StorageType)
            {
                case StorageType.String:
                    w.S = ParamUtil.AsString(value, label) ?? "";
                    break;
                case StorageType.Integer:
                    w.I = value.Type == JTokenType.Boolean ? (ParamUtil.AsBool(value, label) ? 1 : 0) : ParamUtil.AsInt(value, label);
                    break;
                case StorageType.Double:
                    w.D = UnitConversionPolicy.ToInternal(Classify(p), units, ParamUtil.AsDouble(value, label), label);
                    break;
                case StorageType.ElementId:
                    var idTok = value is JObject o && o["id"] != null ? o["id"] : value;
                    w.E = ParamUtil.AsLong(idTok, label);
                    break;
                default:
                    throw new RevitCommandException(ErrorCodes.InvalidParameter,
                        "Unsupported storage type '" + p.StorageType + "' for '" + label + "'.");
            }
            return w;
        }

        private static bool DoublesEqual(double a, double b) =>
            Math.Abs(a - b) <= Math.Max(1e-6, 1e-6 * Math.Abs(b));

        private static bool Equal(Parameter p, PlannedWrite w)
        {
            switch (w.Storage)
            {
                case StorageType.String: return string.Equals(p.AsString() ?? "", w.S, StringComparison.Ordinal);
                case StorageType.Integer: return p.AsInteger() == w.I;
                case StorageType.Double: return DoublesEqual(p.AsDouble(), w.D);
                case StorageType.ElementId: return p.AsElementId().GetValue() == w.E;
                default: return false;
            }
        }

        /// <summary>True if the parameter already holds the planned value.</summary>
        public static bool Matches(PlannedWrite w) => Equal(w.Param, w);

        public static void Apply(PlannedWrite w)
        {
            bool ok;
            switch (w.Storage)
            {
                case StorageType.String: ok = w.Param.Set(w.S); break;
                case StorageType.Integer: ok = w.Param.Set(w.I); break;
                case StorageType.Double: ok = w.Param.Set(w.D); break;
                default: ok = w.Param.Set(MakeId(w.E)); break;
            }
            if (!ok)
                throw new RevitCommandException(ErrorCodes.RevitError, "Revit rejected the value for '" + w.Label + "' (Parameter.Set returned false).");
        }

        /// <summary>
        /// Re-reads the parameter (fresh lookup, so a regenerate can't leave a stale handle) and compares it with
        /// the planned value. Returns the "after" snapshot; throws readback_mismatch on a difference.
        /// </summary>
        public static JObject Verify(Element owner, string name, string builtIn, PlannedWrite w)
        {
            var fresh = Lookup(owner, name, builtIn);
            var after = Snapshot(fresh);
            if (!Equal(fresh, w))
                throw new RevitCommandException(ErrorCodes.ReadbackMismatch,
                    "Readback mismatch on '" + w.Label + "': wrote " + Expected(w) + " but Revit holds " + after["raw"] +
                    " (" + after["display"] + "). Change rolled back.");
            return after;
        }

        private static string Expected(PlannedWrite w)
        {
            switch (w.Storage)
            {
                case StorageType.String: return "\"" + w.S + "\"";
                case StorageType.Integer: return w.I.ToString();
                case StorageType.Double: return w.D.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + " (internal)";
                default: return w.E.ToString();
            }
        }
    }
}
