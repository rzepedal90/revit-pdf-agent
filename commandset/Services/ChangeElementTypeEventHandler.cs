// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services
{
    /// <summary>change_element_type: swap the type of elements after category / valid-type checks, with readback.</summary>
    public class ChangeElementTypeEventHandler : TypedCommandHandlerBase
    {
        public override string GetName() => "change_element_type";

        protected override JObject Run(Document doc, JObject p)
        {
            var idsArr = ParamUtil.Arr(p, "ids");
            if (idsArr.Count == 0)
                throw new RevitCommandException(ErrorCodes.InvalidParameter, "Parameter 'ids' must not be empty.");
            var ids = new List<long>();
            for (int i = 0; i < idsArr.Count; i++) ids.Add(ParamUtil.AsLong(idsArr[i], "ids[" + i + "]"));
            ids = ids.Distinct().ToList();

            var expected = ParamUtil.IntOrNull(p, "expectedCount");
            if (expected.HasValue) ExpectedCountPolicy.Validate(ids.Count, expected.Value);

            var typeIdVal = ParamUtil.Long(p, "typeId");
            var newTypeId = ParameterWriter.MakeId(typeIdVal);
            var newType = doc.GetElement(newTypeId) as ElementType
                ?? throw new RevitCommandException(ErrorCodes.NotFound, "Element " + typeIdVal + " is not a type element.");

            // Validate everything before writing.
            var elements = new List<Element>();
            var problems = new List<string>();
            var notFound = false;
            foreach (var id in ids)
            {
                var el = doc.GetElement(ParameterWriter.MakeId(id));
                if (el == null) { problems.Add(id + ": not found"); notFound = true; continue; }
                var catEl = el.Category;
                var catTy = newType.Category;
                if (catEl != null && catTy != null && catEl.Id != catTy.Id)
                    problems.Add(id + ": category '" + catEl.Name + "' != type category '" + catTy.Name + "'");
                else if (!el.GetValidTypes().Contains(newTypeId))
                    problems.Add(id + ": type '" + newType.Name + "' is not a valid type for this element");
                else
                    elements.Add(el);
            }
            if (problems.Count > 0)
                throw new RevitCommandException(notFound && problems.All(x => x.EndsWith("not found")) ? ErrorCodes.NotFound : ErrorCodes.InvalidParameter,
                    problems.Count + " element(s) rejected, no writes performed: " + string.Join(" | ", problems.Take(10)) +
                    (problems.Count > 10 ? " (+" + (problems.Count - 10) + " more)" : ""));

            var oldTypes = elements.ToDictionary(e => e.Id.GetValue(), e => e.GetTypeId().GetValue());
            var toChange = elements.Where(e => e.GetTypeId() != newTypeId).Select(e => e.Id).ToList();

            return InTransaction(doc, "Change element type", () =>
            {
                if (toChange.Count > 0)
                {
                    Element.ChangeTypeId(doc, toChange, newTypeId);
                    doc.Regenerate();
                }

                var results = new JArray();
                foreach (var el in elements)
                {
                    var id = el.Id.GetValue();
                    var now = doc.GetElement(ParameterWriter.MakeId(id));
                    var nowType = now?.GetTypeId().GetValue();
                    if (nowType != typeIdVal)
                        throw new RevitCommandException(ErrorCodes.ReadbackMismatch,
                            "Readback mismatch on element " + id + ": " + (now == null ? "element no longer exists (replaced?)" : "type is " + nowType + ", expected " + typeIdVal) +
                            ". Change rolled back.");
                    results.Add(new JObject { ["elementId"] = id, ["oldTypeId"] = oldTypes[id], ["newTypeId"] = nowType });
                }
                return new JObject
                {
                    ["ok"] = true,
                    ["typeId"] = typeIdVal,
                    ["typeName"] = newType.Name,
                    ["count"] = results.Count,
                    ["changed"] = toChange.Count,
                    ["items"] = results,
                };
            });
        }
    }
}
