// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
namespace RevitMCPCommandSet.Utils
{
    /// <summary>Spec category of a Double parameter, decoupled from Revit's ForgeTypeId/ParameterType.</summary>
    public enum UnitSpec
    {
        /// <summary>Number, ratio, slope, etc.: units ignored, never converted.</summary>
        Dimensionless,
        Length,
        Area,
        Volume,
        /// <summary>Angle, force, etc.: only units "internal" is accepted.</summary>
        Other,
    }

    /// <summary>
    /// Pure conversion of a caller value to Revit internal units (feet, ft2, ft3).
    /// Length: mm, cm, m, ft. Area: mm2, cm2, m2, ft2. Volume: mm3, cm3, m3, ft3.
    /// "internal" is accepted for every spec. When units is null the metric
    /// millimetre family (mm / mm2 / mm3) is assumed for length/area/volume.
    /// </summary>
    public static class UnitConversionPolicy
    {
        private const double MmPerFt = 304.8;

        public static double ToInternal(UnitSpec spec, string units, double value, string paramName, out bool converted)
        {
            converted = false;
            var u = Normalize(units);
            var label = paramName == null ? "Parameter" : "Parameter '" + paramName + "'";

            if (u == "internal") return value;
            if (spec == UnitSpec.Dimensionless) return value;

            if (spec == UnitSpec.Other)
                throw new RevitCommandException(ErrorCodes.UnitUnsupported,
                    label + " has a measurable spec (angle, force, ...) with no automatic conversion. " +
                    "Pass units:\"internal\" to write the raw Revit internal value.");

            double factor; // multiply value by this to get internal units
            switch (spec)
            {
                case UnitSpec.Length: factor = LengthFactor(u); break;
                case UnitSpec.Area: factor = AreaFactor(u); break;
                default: factor = VolumeFactor(u); break;
            }

            if (double.IsNaN(factor))
                throw new RevitCommandException(ErrorCodes.InvalidParameter,
                    label + " is " + spec + " but units '" + units + "' is not compatible. Use " +
                    "mm/cm/m/ft for length, mm2/cm2/m2/ft2 for area, mm3/cm3/m3/ft3 for volume, or 'internal'.");

            converted = true;
            return value * factor;
        }

        public static double ToInternal(UnitSpec spec, string units, double value, string paramName = null)
            => ToInternal(spec, units, value, paramName, out _);

        private static string Normalize(string units)
        {
            if (units == null) return null;
            return units.Trim().ToLowerInvariant()
                .Replace("²", "2").Replace("³", "3")
                .Replace("^", "").Replace("square_", "sq_").Replace("cubic_", "cu_");
        }

        private static double LengthFactor(string u)
        {
            switch (u)
            {
                case null: case "mm": case "millimeter": case "millimeters": case "millimetre": case "millimetres": return 1.0 / MmPerFt;
                case "cm": case "centimeter": case "centimeters": return 10.0 / MmPerFt;
                case "m": case "meter": case "meters": case "metre": case "metres": return 1000.0 / MmPerFt;
                case "ft": case "feet": case "foot": return 1.0;
                default: return double.NaN;
            }
        }

        private static double AreaFactor(string u)
        {
            switch (u)
            {
                case null: case "mm2": case "sq_mm": case "sq_millimeters": return 1.0 / (MmPerFt * MmPerFt);
                case "cm2": case "sq_cm": case "sq_centimeters": return 100.0 / (MmPerFt * MmPerFt);
                case "m2": case "sq_m": case "sq_meters": return 1e6 / (MmPerFt * MmPerFt);
                case "ft2": case "sq_ft": case "sq_feet": return 1.0;
                default: return double.NaN;
            }
        }

        private static double VolumeFactor(string u)
        {
            switch (u)
            {
                case null: case "mm3": case "cu_mm": case "cu_millimeters": return 1.0 / (MmPerFt * MmPerFt * MmPerFt);
                case "cm3": case "cu_cm": case "cu_centimeters": return 1000.0 / (MmPerFt * MmPerFt * MmPerFt);
                case "m3": case "cu_m": case "cu_meters": return 1e9 / (MmPerFt * MmPerFt * MmPerFt);
                case "ft3": case "cu_ft": case "cu_feet": return 1.0;
                default: return double.NaN;
            }
        }
    }
}
