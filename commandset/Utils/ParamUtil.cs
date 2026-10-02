// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using System.Globalization;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>
    /// Strict, self-describing coercion of loosely typed JSON parameters.
    /// "5" -> 5 and 5.0 -> 5 are accepted (lossless); 5.5 -> int is rejected.
    /// Errors are RevitCommandException(invalid_parameter) naming the key and expected type.
    /// </summary>
    public static class ParamUtil
    {
        private static RevitCommandException Invalid(string key, string expected, JToken t)
        {
            var got = t == null || t.Type == JTokenType.Null ? "null" : t.ToString(Newtonsoft.Json.Formatting.None);
            if (got.Length > 60) got = got.Substring(0, 60) + "...";
            return new RevitCommandException(ErrorCodes.InvalidParameter,
                "Parameter '" + key + "' must be " + expected + ", got " + got + ".");
        }

        private static JToken Require(JObject obj, string key)
        {
            var t = obj?[key];
            if (t == null || t.Type == JTokenType.Null)
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Missing required parameter '" + key + "'.");
            return t;
        }

        private static JToken Optional(JObject obj, string key)
        {
            var t = obj?[key];
            return t == null || t.Type == JTokenType.Null ? null : t;
        }

        // ---- token-level coercion (also used for array elements) ----

        public static string AsString(JToken t, string key)
        {
            if (t is JValue v)
            {
                switch (v.Type)
                {
                    case JTokenType.String:
                        return (string)v.Value;
                    case JTokenType.Integer:
                    case JTokenType.Float:
                    case JTokenType.Boolean:
                    case JTokenType.Date:
                        return Convert.ToString(v.Value, CultureInfo.InvariantCulture);
                }
            }
            throw Invalid(key, "a string", t);
        }

        public static double AsDouble(JToken t, string key)
        {
            if (t is JValue v)
            {
                if (v.Type == JTokenType.Integer || v.Type == JTokenType.Float)
                {
                    var d = Convert.ToDouble(v.Value, CultureInfo.InvariantCulture);
                    if (!double.IsNaN(d) && !double.IsInfinity(d)) return d;
                }
                else if (v.Type == JTokenType.String &&
                    double.TryParse(((string)v.Value ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var s) &&
                    !double.IsNaN(s) && !double.IsInfinity(s))
                {
                    return s;
                }
            }
            throw Invalid(key, "a number", t);
        }

        public static long AsLong(JToken t, string key)
        {
            if (t is JValue v)
            {
                if (v.Type == JTokenType.Integer)
                {
                    try { return Convert.ToInt64(v.Value, CultureInfo.InvariantCulture); }
                    catch (OverflowException) { throw Invalid(key, "an integer", t); }
                }

                double d;
                if (v.Type == JTokenType.Float)
                {
                    d = Convert.ToDouble(v.Value, CultureInfo.InvariantCulture);
                }
                else if (v.Type == JTokenType.String)
                {
                    var s = ((string)v.Value ?? "").Trim();
                    if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l)) return l;
                    if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                        throw Invalid(key, "an integer", t);
                }
                else
                {
                    throw Invalid(key, "an integer", t);
                }

                if (!double.IsNaN(d) && !double.IsInfinity(d) && d == Math.Floor(d) && Math.Abs(d) < 9.2e18)
                    return (long)d;
            }
            throw Invalid(key, "an integer", t);
        }

        public static int AsInt(JToken t, string key)
        {
            var l = AsLong(t, key);
            if (l < int.MinValue || l > int.MaxValue)
                throw Invalid(key, "an integer within " + int.MinValue + ".." + int.MaxValue, t);
            return (int)l;
        }

        public static bool AsBool(JToken t, string key)
        {
            if (t is JValue v)
            {
                if (v.Type == JTokenType.Boolean) return (bool)v.Value;
                if (v.Type == JTokenType.String && bool.TryParse((string)v.Value, out var b)) return b;
            }
            throw Invalid(key, "a boolean", t);
        }

        // ---- object-level getters ----

        public static string Str(JObject o, string key) => AsString(Require(o, key), key);
        public static string StrOrNull(JObject o, string key) { var t = Optional(o, key); return t == null ? null : AsString(t, key); }
        public static double Dbl(JObject o, string key) => AsDouble(Require(o, key), key);
        public static double DblOr(JObject o, string key, double d) { var t = Optional(o, key); return t == null ? d : AsDouble(t, key); }
        public static int Int(JObject o, string key) => AsInt(Require(o, key), key);
        public static int IntOr(JObject o, string key, int d) { var t = Optional(o, key); return t == null ? d : AsInt(t, key); }
        public static int? IntOrNull(JObject o, string key) { var t = Optional(o, key); return t == null ? (int?)null : AsInt(t, key); }
        public static long Long(JObject o, string key) => AsLong(Require(o, key), key);
        public static long? LongOrNull(JObject o, string key) { var t = Optional(o, key); return t == null ? (long?)null : AsLong(t, key); }
        public static bool Bool(JObject o, string key) => AsBool(Require(o, key), key);
        public static bool BoolOr(JObject o, string key, bool d) { var t = Optional(o, key); return t == null ? d : AsBool(t, key); }

        public static JObject Obj(JObject o, string key)
        {
            var t = Require(o, key);
            return t as JObject ?? throw Invalid(key, "an object", t);
        }

        public static JArray Arr(JObject o, string key)
        {
            var t = Require(o, key);
            return t as JArray ?? throw Invalid(key, "an array", t);
        }

        public static JArray ArrOrNull(JObject o, string key)
        {
            var t = Optional(o, key);
            if (t == null) return null;
            return t as JArray ?? throw Invalid(key, "an array", t);
        }

        /// <summary>Any JSON value, required and non-null.</summary>
        public static JToken Any(JObject o, string key) => Require(o, key);

        /// <summary>Any JSON value, or null when absent / JSON null.</summary>
        public static JToken AnyOrNull(JObject o, string key) => Optional(o, key);
    }
}
