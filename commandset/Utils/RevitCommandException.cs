// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
namespace RevitMCPCommandSet.Utils
{
    /// <summary>Well-known typed error codes.</summary>
    public static class ErrorCodes
    {
        public const string InvalidParameter = "invalid_parameter";
        public const string NotFound = "not_found";
        public const string NameCollision = "name_collision";
        public const string IdentityConflict = "identity_conflict";
        public const string UnitUnsupported = "unit_unsupported";
        public const string ReadbackMismatch = "readback_mismatch";
        public const string RevitError = "revit_error";
    }

    /// <summary>
    /// Predictable client/model-state failure with a machine-readable code.
    /// <see cref="Message"/> is "[code] detail" so the code survives transports that
    /// only forward the exception message; <see cref="Detail"/> is the bare text.
    /// </summary>
    public sealed class RevitCommandException : Exception
    {
        public string Code { get; }
        public string Detail { get; }

        public RevitCommandException(string code, string message) : base("[" + code + "] " + message)
        {
            Code = code;
            Detail = message;
        }
    }
}
