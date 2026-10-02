// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.ElementQuery;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.ElementQuery
{
    public abstract class ElementQueryCommandBase<THandler> : ExternalEventCommandBase
        where THandler : ElementQueryHandlerBase, new()
    {
        protected THandler TypedHandler => (THandler)Handler;

        protected ElementQueryCommandBase(UIApplication uiApp) : base(new THandler(), uiApp) { }

        protected virtual int TimeoutMs => 60000;

        public override object Execute(JObject parameters, string requestId)
        {
            TypedHandler.SetParameters(parameters);
            if (!RaiseAndWaitForCompletion(TimeoutMs))
                throw new TimeoutException(CommandName + " timed out");
            if (TypedHandler.Error != null)
                throw new Exception(CommandName + " failed: " + TypedHandler.Error.Message, TypedHandler.Error);
            return TypedHandler.ResultInfo;
        }
    }

    public class GetElementsInfoCommand : ElementQueryCommandBase<GetElementsInfoEventHandler>
    {
        public override string CommandName => "get_elements_info";
        public GetElementsInfoCommand(UIApplication uiApp) : base(uiApp) { }
    }

    public class FindElementsCommand : ElementQueryCommandBase<FindElementsEventHandler>
    {
        public override string CommandName => "find_elements";
        public FindElementsCommand(UIApplication uiApp) : base(uiApp) { }
    }

    public class QueryWhereCommand : ElementQueryCommandBase<QueryWhereEventHandler>
    {
        public override string CommandName => "query_where";
        public QueryWhereCommand(UIApplication uiApp) : base(uiApp) { }
    }

    public class SetSourceKeyCommand : ElementQueryCommandBase<SetSourceKeyEventHandler>
    {
        public override string CommandName => "set_source_key";
        public SetSourceKeyCommand(UIApplication uiApp) : base(uiApp) { }
    }

    public class FindBySourceKeyCommand : ElementQueryCommandBase<FindBySourceKeyEventHandler>
    {
        public override string CommandName => "find_by_source_key";
        public FindBySourceKeyCommand(UIApplication uiApp) : base(uiApp) { }
    }
}
