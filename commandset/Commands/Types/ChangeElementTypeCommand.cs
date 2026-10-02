// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.Types
{
    public class ChangeElementTypeCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private ChangeElementTypeEventHandler _handler => (ChangeElementTypeEventHandler)Handler;

        public override string CommandName => "change_element_type";

        public ChangeElementTypeCommand(UIApplication uiApp)
            : base(new ChangeElementTypeEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                _handler.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(120000))
                    throw new TimeoutException("change_element_type timed out");
                return _handler.GetResultOrThrow();
            }
        }
    }
}
