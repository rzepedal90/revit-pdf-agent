using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using Xunit;

namespace RevitMCPCommandSet.UtilsTests
{
    public class ParamUtilTests
    {
        private static JObject J(string json) => JObject.Parse(json);

        [Fact] public void NumericStringToInt() => Assert.Equal(5, ParamUtil.Int(J("{'n':'5'}"), "n"));
        [Fact] public void IntegralDoubleToInt() => Assert.Equal(5, ParamUtil.Int(J("{'n':5.0}"), "n"));
        [Fact] public void FractionalToIntRejected()
        {
            var ex = Assert.Throws<RevitCommandException>(() => ParamUtil.Int(J("{'n':5.5}"), "n"));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
            Assert.Contains("'n'", ex.Message);
            Assert.Contains("integer", ex.Message);
        }
        [Fact] public void FractionalStringToIntRejected() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Int(J("{'n':'5.5'}"), "n"));
        [Fact] public void GarbageToLongRejected() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Long(J("{'n':'abc'}"), "n"));
        [Fact] public void BoolToIntRejected() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Int(J("{'n':true}"), "n"));
        [Fact] public void IntOutOfRangeRejected() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Int(J("{'n':9999999999}"), "n"));
        [Fact] public void LongAcceptsBigAndString()
        {
            Assert.Equal(9999999999L, ParamUtil.Long(J("{'n':9999999999}"), "n"));
            Assert.Equal(123L, ParamUtil.Long(J("{'n':'123'}"), "n"));
        }
        [Fact] public void DoubleFromStringAndInt()
        {
            Assert.Equal(2.5, ParamUtil.Dbl(J("{'n':'2.5'}"), "n"));
            Assert.Equal(3.0, ParamUtil.Dbl(J("{'n':3}"), "n"));
        }
        [Fact] public void ObjectToDoubleRejected() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Dbl(J("{'n':{'a':1}}"), "n"));
        [Fact] public void RequiredMissingNamesKey()
        {
            var ex = Assert.Throws<RevitCommandException>(() => ParamUtil.Str(J("{}"), "foo"));
            Assert.Contains("'foo'", ex.Message);
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
        }
        [Fact] public void NullIsMissing() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Str(J("{'foo':null}"), "foo"));
        [Fact] public void OptionalGetters()
        {
            var o = J("{}");
            Assert.Null(ParamUtil.StrOrNull(o, "a"));
            Assert.Null(ParamUtil.LongOrNull(o, "a"));
            Assert.Equal(7, ParamUtil.IntOr(o, "a", 7));
            Assert.Equal(1.5, ParamUtil.DblOr(o, "a", 1.5));
            Assert.True(ParamUtil.BoolOr(o, "a", true));
        }
        [Fact] public void StringFromNumber() => Assert.Equal("12", ParamUtil.Str(J("{'n':12}"), "n"));
        [Fact] public void BoolFromString() => Assert.True(ParamUtil.Bool(J("{'b':'true'}"), "b"));
        [Fact] public void ArrayElementLabel()
        {
            var ex = Assert.Throws<RevitCommandException>(() => ParamUtil.AsLong(new JValue("x"), "ids[2]"));
            Assert.Contains("ids[2]", ex.Message);
        }
        [Fact] public void ArrWrongType() =>
            Assert.Throws<RevitCommandException>(() => ParamUtil.Arr(J("{'a':1}"), "a"));
        [Fact] public void MessageCarriesCode()
        {
            var ex = new RevitCommandException(ErrorCodes.NotFound, "x");
            Assert.StartsWith("[not_found]", ex.Message);
            Assert.Equal("x", ex.Detail);
        }
    }

    public class UnitConversionPolicyTests
    {
        [Theory]
        [InlineData("mm", 304.8, 1.0)]
        [InlineData(null, 304.8, 1.0)]
        [InlineData("cm", 30.48, 1.0)]
        [InlineData("m", 0.3048, 1.0)]
        [InlineData("ft", 2.0, 2.0)]
        [InlineData("internal", 2.0, 2.0)]
        public void Length(string units, double input, double expectedFeet) =>
            Assert.Equal(expectedFeet, UnitConversionPolicy.ToInternal(UnitSpec.Length, units, input), 9);

        [Theory]
        [InlineData("mm2", 304.8 * 304.8, 1.0)]
        [InlineData("mm²", 304.8 * 304.8, 1.0)]
        [InlineData(null, 304.8 * 304.8, 1.0)]
        [InlineData("m2", 0.3048 * 0.3048, 1.0)]
        [InlineData("square_meters", 0.3048 * 0.3048, 1.0)]
        [InlineData("ft2", 3.0, 3.0)]
        public void Area(string units, double input, double expected) =>
            Assert.Equal(expected, UnitConversionPolicy.ToInternal(UnitSpec.Area, units, input), 9);

        [Theory]
        [InlineData("mm3", 304.8 * 304.8 * 304.8, 1.0)]
        [InlineData("mm³", 304.8 * 304.8 * 304.8, 1.0)]
        [InlineData("m3", 0.3048 * 0.3048 * 0.3048, 1.0)]
        [InlineData("cubic_feet", 4.0, 4.0)]
        public void Volume(string units, double input, double expected) =>
            Assert.Equal(expected, UnitConversionPolicy.ToInternal(UnitSpec.Volume, units, input), 9);

        [Fact] public void DimensionlessIgnoresUnits()
        {
            Assert.Equal(0.5, UnitConversionPolicy.ToInternal(UnitSpec.Dimensionless, "mm", 0.5, "p", out var c));
            Assert.False(c);
        }

        [Fact] public void ConvertedFlag()
        {
            UnitConversionPolicy.ToInternal(UnitSpec.Length, "mm", 10, "p", out var c);
            Assert.True(c);
            UnitConversionPolicy.ToInternal(UnitSpec.Length, "internal", 10, "p", out c);
            Assert.False(c);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("mm")]
        [InlineData("deg")]
        public void OtherRefusedUnlessInternal(string units)
        {
            var ex = Assert.Throws<RevitCommandException>(() => UnitConversionPolicy.ToInternal(UnitSpec.Other, units, 90, "Angle"));
            Assert.Equal(ErrorCodes.UnitUnsupported, ex.Code);
            Assert.Contains("'Angle'", ex.Message);
        }

        [Fact] public void OtherInternalPassesThrough() =>
            Assert.Equal(1.57, UnitConversionPolicy.ToInternal(UnitSpec.Other, "internal", 1.57));

        [Theory]
        [InlineData(UnitSpec.Length, "mm2")]
        [InlineData(UnitSpec.Area, "mm")]
        [InlineData(UnitSpec.Volume, "m2")]
        [InlineData(UnitSpec.Length, "parsecs")]
        public void FamilyMismatchRejected(UnitSpec spec, string units)
        {
            var ex = Assert.Throws<RevitCommandException>(() => UnitConversionPolicy.ToInternal(spec, units, 1, "p"));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
        }
    }

    public class ExpectedCountPolicyTests
    {
        [Fact] public void MatchingCountPasses() => ExpectedCountPolicy.Validate(3, 3);
        [Fact] public void ZeroZeroPasses() => ExpectedCountPolicy.Validate(0, 0);

        [Theory]
        [InlineData(2, 3)]
        [InlineData(4, 3)]
        [InlineData(0, 1)]
        public void MismatchIsIdentityConflict(int actual, int expected)
        {
            var ex = Assert.Throws<RevitCommandException>(() => ExpectedCountPolicy.Validate(actual, expected));
            Assert.Equal(ErrorCodes.IdentityConflict, ex.Code);
            Assert.Contains("no writes performed", ex.Message);
        }

        [Fact] public void NegativeExpectedRejected()
        {
            var ex = Assert.Throws<RevitCommandException>(() => ExpectedCountPolicy.Validate(0, -1));
            Assert.Equal(ErrorCodes.InvalidParameter, ex.Code);
        }
    }
}
