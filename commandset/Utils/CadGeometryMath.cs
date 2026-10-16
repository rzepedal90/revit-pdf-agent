using System.Text.RegularExpressions;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>Revit-independent helpers for CAD import geometry: polyline metrics and layer-name matching.</summary>
    public static class CadGeometryMath
    {
        public struct PolyMetrics
        {
            public double MinX, MinY, MaxX, MaxY;
            public double CentroidX, CentroidY;
            public bool Closed;
            public double Area; // absolute area; 0 when not closed
        }

        /// <summary>True when first and last points coincide within tol.</summary>
        public static bool IsClosed(IReadOnlyList<(double X, double Y)> pts, double tol = 0.5)
        {
            if (pts == null || pts.Count < 3) return false;
            var a = pts[0]; var b = pts[pts.Count - 1];
            return Math.Abs(a.X - b.X) <= tol && Math.Abs(a.Y - b.Y) <= tol;
        }

        public static PolyMetrics Measure(IReadOnlyList<(double X, double Y)> pts, double closeTol = 0.5)
        {
            if (pts == null || pts.Count == 0) throw new ArgumentException("Polyline needs at least one point.");
            var m = new PolyMetrics { MinX = double.MaxValue, MinY = double.MaxValue, MaxX = double.MinValue, MaxY = double.MinValue };
            foreach (var p in pts)
            {
                m.MinX = Math.Min(m.MinX, p.X); m.MaxX = Math.Max(m.MaxX, p.X);
                m.MinY = Math.Min(m.MinY, p.Y); m.MaxY = Math.Max(m.MaxY, p.Y);
            }
            m.Closed = IsClosed(pts, closeTol);
            int n = pts.Count;
            if (m.Closed)
            {
                int cnt = n - 1; // drop duplicated closing vertex
                double a2 = 0, cx = 0, cy = 0;
                for (int i = 0; i < cnt; i++)
                {
                    var p = pts[i]; var q = pts[(i + 1) % cnt];
                    double cr = p.X * q.Y - q.X * p.Y;
                    a2 += cr; cx += (p.X + q.X) * cr; cy += (p.Y + q.Y) * cr;
                }
                if (Math.Abs(a2) > 1e-9)
                {
                    m.Area = Math.Abs(a2) / 2.0;
                    m.CentroidX = cx / (3.0 * a2); m.CentroidY = cy / (3.0 * a2);
                    return m;
                }
            }
            int k = m.Closed ? Math.Max(1, n - 1) : n;
            double ssx = 0, ssy = 0;
            for (int i = 0; i < k; i++) { ssx += pts[i].X; ssy += pts[i].Y; }
            m.CentroidX = ssx / k; m.CentroidY = ssy / k;
            return m;
        }

        /// <summary>Short layer name: text after the last '$'.</summary>
        public static string ShortLayerName(string name)
        {
            if (string.IsNullOrEmpty(name)) return name ?? "";
            int i = name.LastIndexOf('$');
            return i >= 0 && i < name.Length - 1 ? name.Substring(i + 1) : name;
        }

        /// <summary>
        /// Case-insensitive match. A pattern with '*' is a wildcard over the full or short name; otherwise exact match on
        /// the full or short name, or a suffix match on a '$' boundary ("0-PILARES" matches "Xref N1$0$0-PILARES").
        /// </summary>
        public static bool LayerMatches(string layerName, string pattern)
        {
            if (string.IsNullOrEmpty(layerName) || string.IsNullOrEmpty(pattern)) return false;
            if (pattern.IndexOf('*') >= 0)
            {
                var rx = new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*") + "$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                return rx.IsMatch(layerName) || rx.IsMatch(ShortLayerName(layerName));
            }
            if (layerName.Equals(pattern, StringComparison.OrdinalIgnoreCase)) return true;
            if (ShortLayerName(layerName).Equals(pattern, StringComparison.OrdinalIgnoreCase)) return true;
            return layerName.Length > pattern.Length
                   && layerName.EndsWith(pattern, StringComparison.OrdinalIgnoreCase)
                   && layerName[layerName.Length - pattern.Length - 1] == '$';
        }

        /// <summary>Null/empty pattern list matches everything.</summary>
        public static bool LayerMatchesAny(string layerName, IEnumerable<string> patterns)
        {
            if (patterns == null) return true;
            bool any = false;
            foreach (var p in patterns) { any = true; if (LayerMatches(layerName, p)) return true; }
            return !any;
        }

        public static bool BBoxIntersects(double aMinX, double aMinY, double aMaxX, double aMaxY,
            double bMinX, double bMinY, double bMaxX, double bMaxY)
            => aMaxX >= bMinX && aMinX <= bMaxX && aMaxY >= bMinY && aMinY <= bMaxY;
    }
}
