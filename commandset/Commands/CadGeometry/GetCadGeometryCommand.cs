using Autodesk.Revit.UI;
using RevitMCPCommandSet.Commands.ElementQuery;
using RevitMCPCommandSet.Services.CadGeometry;

namespace RevitMCPCommandSet.Commands.CadGeometry
{
    /// <summary>get_cad_geometry: read-only extraction of imported CAD (ImportInstance) geometry per layer.</summary>
    public class GetCadGeometryCommand : ElementQueryCommandBase<GetCadGeometryEventHandler>
    {
        public override string CommandName => "get_cad_geometry";
        protected override int TimeoutMs => 180000;
        public GetCadGeometryCommand(UIApplication uiApp) : base(uiApp) { }
    }
}
