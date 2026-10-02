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

        [Fact] public void ParametersParsed()
        {
            var s = BuildElementsModel.Parse(Req(Footing.TrimEnd('}') + ",'parameters':[{'name':'Mark','value':'F1'},{'builtIn':'ALL_MODEL_MARK','value':3,'units':'mm'}]}"));
            Assert.Equal(2, s.Items[0].Parameters.Count);
            Assert.Throws<RevitCommandException>(() => BuildElementsModel.Parse(Req(Footing.TrimEnd('}') + ",'parameters':[{'value':1}]}")));
        }
    }
}
