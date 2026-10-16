using RevitMCPCommandSet.Utils;
using Xunit;

namespace RevitMCPCommandSet.UtilsTests
{
    public class CadGeometryMathTests
    {
        private static List<(double X, double Y)> Sq() => new() { (0, 0), (100, 0), (100, 50), (0, 50), (0, 0) };

        [Fact] public void ClosedSquareAreaCentroid()
        {
            var m = CadGeometryMath.Measure(Sq());
            Assert.True(m.Closed);
            Assert.Equal(5000, m.Area, 6);
            Assert.Equal(50, m.CentroidX, 6);
            Assert.Equal(25, m.CentroidY, 6);
            Assert.Equal(100, m.MaxX);
        }
        [Fact] public void ClockwiseAreaPositive()
        {
            var pts = Sq(); pts.Reverse();
            Assert.Equal(5000, CadGeometryMath.Measure(pts).Area, 6);
        }
        [Fact] public void OpenPolylineNotClosed()
        {
            var m = CadGeometryMath.Measure(new List<(double X, double Y)> { (0, 0), (10, 0), (10, 10) });
            Assert.False(m.Closed);
            Assert.Equal(0, m.Area);
        }
        [Fact] public void ClosedWithinTolerance() =>
            Assert.True(CadGeometryMath.IsClosed(new List<(double X, double Y)> { (0, 0), (10, 0), (10, 10), (0.3, 0.2) }));
        [Fact] public void ShortName() =>
            Assert.Equal("0-PILARES", CadGeometryMath.ShortLayerName("Xref N1$0$0-PILARES"));
        [Fact] public void SuffixMatchCaseInsensitive() =>
            Assert.True(CadGeometryMath.LayerMatches("Xref N1$0$0-PILARES", "0-pilares"));
        [Fact] public void SuffixMustBeOnDollarBoundary() =>
            Assert.False(CadGeometryMath.LayerMatches("Xref N1$0$0-PILARES", "ILARES"));
        [Fact] public void Wildcard()
        {
            Assert.True(CadGeometryMath.LayerMatches("Xref N1$0$0-PILARES", "*PILAR*"));
            Assert.True(CadGeometryMath.LayerMatches("Xref N1$0$0-PILARES", "0-PIL*"));
            Assert.False(CadGeometryMath.LayerMatches("Xref N1$0$0-MUROS", "*PILAR*"));
        }
        [Fact] public void ExactFull() => Assert.True(CadGeometryMath.LayerMatches("A$B", "a$b"));
        [Fact] public void NullPatternsMatchAll() => Assert.True(CadGeometryMath.LayerMatchesAny("X", null));
        [Fact] public void BBox()
        {
            Assert.True(CadGeometryMath.BBoxIntersects(0, 0, 10, 10, 5, 5, 20, 20));
            Assert.False(CadGeometryMath.BBoxIntersects(0, 0, 10, 10, 11, 0, 20, 20));
        }
    }
}
