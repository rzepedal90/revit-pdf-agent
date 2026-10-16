using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using Xunit;

namespace RevitMCPCommandSet.UtilsTests
{
    public class BuildElementsModelTests
    {
        private static JObject J(string json) => JObject.Parse(json);

        private const string Footing =
            "{'sourceKey':'K1','kind':'footing','typeName':'Z1','point':{'x':1000,'y':2000},'rotationDeg':30,'level':'N','offsetMm':-500}";

        private static JObject Req(string element, string extra = "") =>
            J("{" + extra + "'elements':[" + element + "]}");

        [Fact] public void DefaultsAreDryRunUpsert()
        {
            var s = BuildElementsModel.Parse(Req(Footing));
            Assert.True(s.DryRun);
            Assert.Equal("upsert", s.Mode);
        }

        [Fact] public void TransformRotatesThenTranslates()
        {
            var p = BuildElementsModel.ApplyTransform(new MmPoint(1000, 0), 100, 200, 90);
            Assert.Equal(100, p.X, 6);
            Assert.Equal(1200, p.Y, 6);
        }

        [Fact] public void TransformAppliedToPointAndRotation()
        {
            var s = BuildElementsModel.Parse(Req(Footing, "'transform':{'originMm':{'x':10,'y':20},'rotationDeg':90},"));
            var it = s.Items[0];
            Assert.Equal(10 - 2000, it.Point.X, 6);
            Assert.Equal(20 + 1000, it.Point.Y, 6);
            Assert.Equal(120, it.RotationDeg, 6);
        }

        [Fact] public void MissingVerticalValueIsInvalidParameter()
        {
            var ex = Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'K1','kind':'footing','typeName':'Z1','point':{'x':0,'y':0},'rotationDeg':0,'level':'N'}")));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
            Assert.Contains("offsetMm", ex.Message);
            Assert.Contains("K1", ex.Message);
        }

        [Fact] public void ColumnRequiresBothLevelsAndOffsets()
        {
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'C','kind':'column','typeName':'C1','point':{'x':0,'y':0},'rotationDeg':0,'baseLevel':'A','baseOffsetMm':0,'topLevel':'B'}")));
        }

        [Fact] public void BeamDefaultsZJustificationToTop()
        {
            var s = BuildElementsModel.Parse(Req(
                "{'sourceKey':'B','kind':'beam','typeName':'V','start':{'x':0,'y':0},'end':{'x':5000,'y':0},'level':'N','startOffsetMm':0,'endOffsetMm':0}"));
            Assert.Equal("top", s.Items[0].ZJustification);
            Assert.Equal(0, BuildElementsModel.ZJustificationValue("top"));
        }

        [Fact] public void BeamRejectsBadJustification() =>
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'B','kind':'beam','typeName':'V','start':{'x':0,'y':0},'end':{'x':5000,'y':0},'level':'N','startOffsetMm':0,'endOffsetMm':0,'zJustification':'middle'}")));

        [Fact] public void WallNeedsTopOrHeightButNotBoth()
        {
            const string w = "'sourceKey':'W','kind':'wall','typeName':'M','start':{'x':0,'y':0},'end':{'x':3000,'y':0},'baseLevel':'N','baseOffsetMm':0";
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{" + w + "}")));
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{" + w + ",'topLevel':'T','topOffsetMm':0,'heightMm':2500}")));
            var a = BuildElementsModel.Parse(Req("{" + w + ",'heightMm':2500}")).Items[0];
            Assert.Equal(2500, a.HeightMm);
            Assert.True(a.Structural);
            Assert.Equal("center", a.LocationLine);
            var b = BuildElementsModel.Parse(Req("{" + w + ",'topLevel':'T','topOffsetMm':-100}")).Items[0];
            Assert.Equal("T", b.TopLevel);
            Assert.Null(b.HeightMm);
        }

        [Fact] public void GridNeedsNoType()
        {
            var s = BuildElementsModel.Parse(Req("{'sourceKey':'G','kind':'grid','name':'A','start':{'x':0,'y':0},'end':{'x':0,'y':9000}}"));
            Assert.Equal("A", s.Items[0].GridName);
        }

        [Fact] public void TypeRequiredForNonGrid() =>
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'K1','kind':'footing','point':{'x':0,'y':0},'rotationDeg':0,'level':'N','offsetMm':0}")));

        private const string Fam =
            "{'sourceKey':'P1','kind':'family','familyName':'Plaza de aparcamiento 2D','typeName':'5000x2500','category':'OST_Parking','point':{'x':100,'y':200},'rotationDeg':90,'level':'N','offsetMm':0";

        [Fact] public void FamilyParsesWithCategoryAndParameters()
        {
            var it = BuildElementsModel.Parse(Req(Fam + ",'parameters':[{'name':'Comments','value':'x'}]}")).Items[0];
            Assert.Equal("family", it.Kind);
            Assert.Equal("OST_Parking", it.Category);
            Assert.Equal(100, it.Point.X, 6);
            Assert.Equal(90, it.RotationDeg, 6);
            Assert.Equal("N", it.Level);
            Assert.Single(it.Parameters);
        }

        [Fact] public void FamilyCategoryIsOptional() =>
            Assert.Null(BuildElementsModel.Parse(Req("{'sourceKey':'P1','kind':'family','typeId':5,'point':{'x':0,'y':0},'rotationDeg':0,'level':'N','offsetMm':0}")).Items[0].Category);

        [Fact] public void FamilyMissingOffsetRejected()
        {
            var ex = Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'P1','kind':'family','typeName':'T','point':{'x':0,'y':0},'rotationDeg':0,'level':'N'}")));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
            Assert.Contains("offsetMm", ex.Message);
        }

        [Fact] public void FamilyMissingTypeRejected() =>
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(
                "{'sourceKey':'P1','kind':'family','point':{'x':0,'y':0},'rotationDeg':0,'level':'N','offsetMm':0}")));

        [Fact] public void FamilyBadCategoryNameRejected()
        {
            var ex = Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(Fam.Replace("OST_Parking", "Parking") + "}")));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
            Assert.Contains("category", ex.Message);
        }

        [Fact] public void DuplicateSourceKeyRejected() =>
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(J("{'elements':[" + Footing + "," + Footing + "]}")));

        [Fact] public void MoreThan500Rejected()
        {
            var arr = new JArray();
            for (int i = 0; i < 501; i++) { var e = J(Footing); e["sourceKey"] = "K" + i; arr.Add(e); }
            var ex = Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(new JObject { ["elements"] = arr }));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
        }

        [Fact] public void BadModeRejected() =>
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(Footing, "'mode':'replace',")));

        [Fact] public void ToleranceHelpers()
        {
            Assert.True(BuildElementsModel.NearMm(100.4, 100.0));
            Assert.False(BuildElementsModel.NearMm(100.6, 100.0));
            Assert.Equal(0.02, BuildElementsModel.AngleDiffDeg(359.99, 0.01), 6);
            Assert.Equal(350, BuildElementsModel.NormalizeDeg(-10), 6);
        }

        private const string FloorHead = "'sourceKey':'FL','kind':'floor','typeName':'Losa','level':'N','offsetMm':-50";

        [Fact] public void FloorParsesBoundaryAndDefaults()
        {
            var it = BuildElementsModel.Parse(Req("{" + FloorHead +
                ",'boundary':[[{'x':0,'y':0},{'x':4000,'y':0},{'x':4000,'y':3000},{'x':0,'y':3000}],[{'x':1000,'y':1000},{'x':2000,'y':1000},{'x':2000,'y':2000}]]}")).Items[0];
            Assert.Equal("floor", it.Kind);
            Assert.False(it.Structural);
            Assert.Equal(-50, it.OffsetMm);
            Assert.Equal(2, it.Boundary.Count);
            Assert.Equal(4, it.Boundary[0].Count);
        }

        [Fact] public void FloorRequiresOffsetAndBoundary()
        {
            const string b = ",'boundary':[[{'x':0,'y':0},{'x':4000,'y':0},{'x':4000,'y':3000}]]";
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{'sourceKey':'FL','kind':'floor','typeName':'L','level':'N'" + b + "}")));
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{" + FloorHead + "}")));
        }

        [Fact] public void FloorRemovesDegenerateAndClosingPoints()
        {
            var it = BuildElementsModel.Parse(Req("{" + FloorHead +
                ",'boundary':[[{'x':0,'y':0},{'x':0.4,'y':0.2},{'x':4000,'y':0},{'x':4000,'y':3000},{'x':0,'y':0}]]}")).Items[0];
            Assert.Equal(3, it.Boundary[0].Count);
        }

        [Fact] public void FloorRejectsTooFewOrCollinearPoints()
        {
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{" + FloorHead +
                ",'boundary':[[{'x':0,'y':0},{'x':4000,'y':0},{'x':4000.5,'y':0}]]}")));
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req("{" + FloorHead +
                ",'boundary':[[{'x':0,'y':0},{'x':1000,'y':0},{'x':2000,'y':0}]]}")));
        }

        [Fact] public void FloorBoundaryTransformedAndExtent()
        {
            var it = BuildElementsModel.Parse(Req("{" + FloorHead +
                ",'boundary':[[{'x':0,'y':0},{'x':4000,'y':0},{'x':4000,'y':3000},{'x':0,'y':3000}]]}",
                "'transform':{'originMm':{'x':100,'y':200},'rotationDeg':90},")).Items[0];
            var e = BuildElementsModel.Extent(it.Boundary[0]);
            Assert.Equal(100 - 3000, e[0], 6);
            Assert.Equal(200, e[1], 6);
            Assert.Equal(100, e[2], 6);
            Assert.Equal(200 + 4000, e[3], 6);
        }

        [Fact] public void BoundariesEqualIgnoresOrderStartAndDirection()
        {
            var a = new List<MmPoint> { new MmPoint(0, 0), new MmPoint(10, 0), new MmPoint(10, 10) };
            var b = new List<MmPoint> { new MmPoint(10, 10), new MmPoint(10, 0.3), new MmPoint(0, 0) };
            Assert.True(BuildElementsModel.BoundariesEqual(new[] { a }, new[] { b }));
            b[0] = new MmPoint(10, 12);
            Assert.False(BuildElementsModel.BoundariesEqual(new[] { a }, new[] { b }));
        }

        [Fact] public void WallArchitecturalAndLocationLineAliases()
        {
            const string w = "'sourceKey':'W','kind':'wall','typeName':'M','start':{'x':0,'y':0},'end':{'x':3000,'y':0},'baseLevel':'N','baseOffsetMm':0,'heightMm':2500";
            var a = BuildElementsModel.Parse(Req("{" + w + ",'structural':false,'locationLine':'finishFaceExterior'}")).Items[0];
            Assert.False(a.Structural);
            Assert.Equal("finish_exterior", a.LocationLine);
            Assert.Equal(2, BuildElementsModel.LocationLineValue(a.LocationLine));
            Assert.Equal(0, BuildElementsModel.LocationLineValue(BuildElementsModel.ParseLocationLine("center")));
            Assert.Equal(1, BuildElementsModel.LocationLineValue(BuildElementsModel.ParseLocationLine("coreCenter")));
            Assert.Equal(3, BuildElementsModel.LocationLineValue(BuildElementsModel.ParseLocationLine("finish_interior")));
            Assert.Equal(4, BuildElementsModel.LocationLineValue(BuildElementsModel.ParseLocationLine("coreExterior")));
            Assert.Equal(5, BuildElementsModel.LocationLineValue(BuildElementsModel.ParseLocationLine("core_interior")));
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.ParseLocationLine("left"));
        }

        [Fact] public void ParametersParsed()
        {
            var s = BuildElementsModel.Parse(Req(Footing.TrimEnd('}') + ",'parameters':[{'name':'Mark','value':'F1'},{'builtIn':'ALL_MODEL_MARK','value':3,'units':'mm'}]}"));
            Assert.Equal(2, s.Items[0].Parameters.Count);
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(Footing.TrimEnd('}') + ",'parameters':[{'value':1}]}")));
        }
    }
}
