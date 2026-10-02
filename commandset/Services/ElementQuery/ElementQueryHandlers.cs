// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Utils;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.ElementQuery
{
    /// <summary>Common plumbing: parameters in, JObject result (or captured error) out.</summary>
    public abstract class ElementQueryHandlerBase : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private JObject _params = new JObject();
        public JObject ResultInfo { get; private set; }
        public Exception Error { get; private set; }
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public void SetParameters(JObject p)
        {
            _params = p ?? new JObject();
            ResultInfo = null;
            Error = null;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var doc = app.ActiveUIDocument.Document;
                ResultInfo = Run(doc, _params);
            }
            catch (Exception ex)
            {
                Error = ex;
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        protected abstract JObject Run(Document doc, JObject p);
        public abstract string GetName();
    }

    public class GetElementsInfoEventHandler : ElementQueryHandlerBase
    {
        public const int MaxIds = 200;

        protected override JObject Run(Document doc, JObject p)
        {
            var ids = p["ids"] as JArray;
            if (ids == null || ids.Count == 0) throw new ArgumentException("'ids' (array of element ids) is required.");
            if (ids.Count > MaxIds) throw new ArgumentException("At most " + MaxIds + " ids per call.");
            var fields = ElementQueryUtils.ParseFields(p["fields"], ElementQueryUtils.AllFields);
            var items = new JArray();
            var notFound = new JArray();
            foreach (var t in ids)
            {
                long id = t.Value<long>();
                var el = doc.GetElement(ElementQueryUtils.ToElementId(id));
                if (el == null) { notFound.Add(id); continue; }
                items.Add(ElementQueryUtils.BuildInfo(doc, el, fields));
            }
            return new JObject { ["count"] = items.Count, ["items"] = items, ["notFound"] = notFound };
        }

        public override string GetName() => "get_elements_info";
    }

    public class FindElementsEventHandler : ElementQueryHandlerBase
    {
        protected override JObject Run(Document doc, JObject p)
        {
            var spec = ElementQueryUtils.FilterSpec.Parse(p, "auto");
            int limit = Math.Max(1, Math.Min(500, ElementQueryUtils.GetInt(p, "limit", 50)));
            int offset = Math.Max(0, ElementQueryUtils.GetInt(p, "offset", 0));
            var fields = ElementQueryUtils.ParseFields(p["fields"], ElementQueryUtils.DefaultFindFields);

            int total = 0;
            var page = new List<Element>();
            foreach (var el in spec.Collect(doc))
            {
                if (!spec.Match(doc, el)) continue;
                if (total >= offset && page.Count < limit) page.Add(el);
                total++;
            }
            var items = new JArray();
            foreach (var el in page) items.Add(ElementQueryUtils.BuildInfo(doc, el, fields));
            bool hasMore = offset + page.Count < total;
            var r = new JObject { ["total"] = total, ["hasMore"] = hasMore };
            r["nextOffset"] = hasMore ? (JToken)(offset + page.Count) : JValue.CreateNull();
            r["items"] = items;
            return r;
        }

        public override string GetName() => "find_elements";
    }

    public class QueryWhereEventHandler : ElementQueryHandlerBase
    {
        protected override JObject Run(Document doc, JObject p)
        {
            var scope = (ElementQueryUtils.GetString(p, "scope") ?? "auto").ToLowerInvariant();
            var spec = ElementQueryUtils.FilterSpec.Parse(p, scope);
            int limit = Math.Max(0, Math.Min(500, ElementQueryUtils.GetInt(p, "limit", 50)));
            var groupBy = ElementQueryUtils.GetString(p, "groupBy")?.ToLowerInvariant();
            if (groupBy != null && groupBy != "type" && groupBy != "level" && groupBy != "category")
                throw new ArgumentException("groupBy must be type|level|category.");

            int count = 0;
            var ids = new JArray();
            var groups = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var el in spec.Collect(doc))
            {
                if (!spec.Match(doc, el)) continue;
                count++;
                if (ids.Count < limit) ids.Add(el.Id.GetValue());
                if (groupBy == null) continue;
                string key;
                if (groupBy == "type")
                {
                    var fam = ElementQueryUtils.FamilyName(doc, el);
                    var tn = ElementQueryUtils.TypeName(doc, el);
                    key = string.IsNullOrEmpty(fam) ? tn : fam + ": " + tn;
                }
                else if (groupBy == "level") key = ElementQueryUtils.GetLevel(doc, el)?.Name ?? "(none)";
                else key = el.Category?.Name ?? "(none)";
                key = key ?? "(none)";
                groups[key] = groups.TryGetValue(key, out var n) ? n + 1 : 1;
            }
            var r = new JObject { ["count"] = count, ["ids"] = ids, ["truncated"] = count > ids.Count };
            if (groupBy != null)
            {
                var g = new JArray();
                foreach (var kv in groups.OrderByDescending(x => x.Value).ThenBy(x => x.Key, StringComparer.Ordinal))
                    g.Add(new JObject { ["key"] = kv.Key, ["count"] = kv.Value });
                r["groupBy"] = groupBy;
                r["groups"] = g;
            }
            return r;
        }

        public override string GetName() => "query_where";
    }

    public class SetSourceKeyEventHandler : ElementQueryHandlerBase
    {
        protected override JObject Run(Document doc, JObject p)
        {
            var items = p["items"] as JArray;
            if (items == null || items.Count == 0) throw new ArgumentException("'items' ([{id, sourceKey}]) is required.");
            if (items.Count > 500) throw new ArgumentException("At most 500 items per call.");
            bool allowDuplicate = p["allowDuplicate"] != null && p["allowDuplicate"].Type == JTokenType.Boolean && p["allowDuplicate"].Value<bool>();

            var existing = SourceKeyStore.ScanAll(doc);
            var results = new JArray();
            int ok = 0, failed = 0;

            using (var tx = new Transaction(doc, "Set source keys"))
            {
                tx.Start();
                SourceKeyStore.GetOrCreateSchema();
                foreach (var t in items)
                {
                    var o = t as JObject;
                    long id = o?["id"] != null ? o["id"].Value<long>() : -1;
                    string key = o == null ? null : ElementQueryUtils.GetString(o, "sourceKey");
                    string hash = o == null ? null : ElementQueryUtils.GetString(o, "manifestHash");
                    string err = null;
                    try
                    {
                        var el = id < 0 ? null : doc.GetElement(ElementQueryUtils.ToElementId(id));
                        if (el == null) err = "element not found";
                        else if (key == null) err = "sourceKey is empty";
                        else
                        {
                            var others = existing.TryGetValue(key, out var list)
                                ? list.Where(e => e.Id != el.Id).Select(e => e.Id.GetValue()).ToList()
                                : new List<long>();
                            if (others.Count > 0 && !allowDuplicate)
                                err = "duplicate: key already used by element " + string.Join(",", others.Take(5));
                            else
                            {
                                var old = SourceKeyStore.Read(el);
                                SourceKeyStore.Write(el, key, hash);
                                if (old != null && existing.TryGetValue(old, out var ol))
                                {
                                    ol.RemoveAll(e => e.Id == el.Id);
                                    if (ol.Count == 0) existing.Remove(old);
                                }
                                if (!existing.TryGetValue(key, out var nl)) existing[key] = nl = new List<Element>();
                                if (!nl.Any(e => e.Id == el.Id)) nl.Add(el);
                            }
                        }
                    }
                    catch (Exception ex) { err = ex.Message; }

                    var res = new JObject { ["id"] = id, ["ok"] = err == null };
                    if (err != null) { res["error"] = err; failed++; } else ok++;
                    results.Add(res);
                }
                tx.Commit();
            }
            return new JObject { ["set"] = ok, ["failed"] = failed, ["results"] = results };
        }

        public override string GetName() => "set_source_key";
    }

    public class FindBySourceKeyEventHandler : ElementQueryHandlerBase
    {
        protected override JObject Run(Document doc, JObject p)
        {
            var keysTok = p["keys"] as JArray;
            var prefix = ElementQueryUtils.GetString(p, "prefix");
            if ((keysTok == null || keysTok.Count == 0) && prefix == null)
                throw new ArgumentException("Provide 'keys' and/or 'prefix'.");
            int limit = Math.Max(1, Math.Min(1000, ElementQueryUtils.GetInt(p, "limit", 200)));

            var map = SourceKeyStore.ScanAll(doc);
            var wanted = new List<string>();
            var notFound = new JArray();
            if (keysTok != null)
                foreach (var k in keysTok)
                {
                    var key = k.ToString();
                    if (map.ContainsKey(key)) { if (!wanted.Contains(key)) wanted.Add(key); }
                    else notFound.Add(key);
                }
            if (prefix != null)
                foreach (var key in map.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).OrderBy(k => k, StringComparer.Ordinal))
                    if (!wanted.Contains(key)) wanted.Add(key);

            var matches = new JArray();
            var duplicates = new JArray();
            foreach (var key in wanted)
            {
                var list = map[key];
                if (list.Count > 1)
                    duplicates.Add(new JObject { ["sourceKey"] = key, ["ids"] = new JArray(list.Select(e => e.Id.GetValue())) });
                foreach (var el in list)
                {
                    if (matches.Count >= limit) break;
                    matches.Add(new JObject
                    {
                        ["id"] = el.Id.GetValue(),
                        ["uniqueId"] = el.UniqueId,
                        ["category"] = el.Category?.Name,
                        ["type"] = ElementQueryUtils.TypeName(doc, el),
                        ["sourceKey"] = key,
                    });
                }
            }
            int totalElements = wanted.Sum(k => map[k].Count);
            return new JObject
            {
                ["total"] = totalElements,
                ["truncated"] = totalElements > matches.Count,
                ["matches"] = matches,
                ["notFound"] = notFound,
                ["duplicates"] = duplicates,
            };
        }

        public override string GetName() => "find_by_source_key";
    }
}
