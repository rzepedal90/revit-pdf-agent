// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
namespace RevitMCPCommandSet.Utils
{
    /// <summary>Pure pre-write count guard: call before writing anything.</summary>
    public static class ExpectedCountPolicy
    {
        public static void Validate(int actual, int expected)
        {
            if (expected < 0)
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "expectedCount must be non-negative.");
            if (actual != expected)
                throw new RevitCommandException(ErrorCodes.IdentityConflict,
                    $"Expected {expected} matching element(s), found {actual}; no writes performed.");
        }
    }
}
