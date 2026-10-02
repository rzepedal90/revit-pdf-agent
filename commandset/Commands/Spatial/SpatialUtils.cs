// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Commands.Spatial
{
    internal static class SpatialUtils
    {
        public const double FeetToMm = 304.8;

        public static ElementId MakeId(long value)
        {
#if REVIT2024_OR_GREATER
            return new ElementId(value);
#else
            return new ElementId((int)value);
#endif
        }

        public static long IdValue(ElementId id)
        {
#if REVIT2024_OR_GREATER
            return id.Value;
#else
            return id.IntegerValue;
#endif
        }

        public static JToken IdOrNull(ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return JValue.CreateNull();
            return IdValue(id);
        }

        private static double R(double v, int digits) => Math.Round(v, digits);

        /// <summary>Point in both millimetres and feet.</summary>
        public static JObject Pt(XYZ p)
        {
            return new JObject
            {
                ["mm"] = new JArray(R(p.X * FeetToMm, 3), R(p.Y * FeetToMm, 3), R(p.Z * FeetToMm, 3)),
                ["ft"] = new JArray(R(p.X, 6), R(p.Y, 6), R(p.Z, 6)),
            };
        }

        public static JArray Dir(XYZ d)
        {
            return new JArray(R(d.X, 6), R(d.Y, 6), R(d.Z, 6));
        }

        public static JObject Box(BoundingBoxXYZ box)
        {
            if (box == null) return null;
            var o = new JObject { ["min"] = Pt(box.Min), ["max"] = Pt(box.Max) };
            var t = box.Transform;
            if (t != null && !t.IsIdentity)
            {
                o["transform"] = new JObject
                {
                    ["origin"] = Pt(t.Origin),
                    ["basisX"] = Dir(t.BasisX),
                    ["basisY"] = Dir(t.BasisY),
                    ["basisZ"] = Dir(t.BasisZ),
                };
            }
            return o;
        }
    }
}
