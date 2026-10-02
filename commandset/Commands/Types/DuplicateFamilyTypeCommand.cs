// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Types
{
    public class DuplicateFamilyTypeCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private DuplicateFamilyTypeEventHandler _handler => (DuplicateFamilyTypeEventHandler)Handler;

        public override string CommandName => "duplicate_family_type";

        public DuplicateFamilyTypeCommand(UIApplication uiApp)
            : base(new DuplicateFamilyTypeEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(60000))
                    throw new TimeoutException("duplicate_family_type timed out");
                return _handler.GetResultOrThrow();
            }
        }
    }
}
