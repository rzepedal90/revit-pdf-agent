// Portions adapted from pdftorevit-agent (https://github.com/BadAstronaut/pdftorevit-agent), MIT, Copyright (c) 2026 Le Phu; based on KenLP/RevitMCPServer.
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Utils
{
    /// <summary>
    /// Base external-event handler for commands that report typed errors.
    /// Subclasses implement <see cref="Run"/>; any <see cref="RevitCommandException"/> it throws
    /// (or any other exception, mapped to revit_error) is rethrown by <see cref="GetResultOrThrow"/>
    /// on the command thread.
    /// </summary>
    public abstract class TypedCommandHandlerBase : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public JObject Parameters { get; set; }

        private JObject _result;
        private RevitCommandException _error;

        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        protected abstract JObject Run(Document doc, JObject parameters);

        public abstract string GetName();

        public void Execute(UIApplication app)
        {
            _result = null;
            _error = null;
            try
            {
                var doc = app.ActiveUIDocument?.Document
                    ?? throw new RevitCommandException(ErrorCodes.RevitError, "No active Revit document.");
                _result = Run(doc, Parameters);
            }
            catch (RevitCommandException ex)
            {
                _error = ex;
            }
            catch (Exception ex)
            {
                _error = new RevitCommandException(ErrorCodes.RevitError, ex.Message);
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        /// <summary>Returns the result, or throws the typed error produced by Run.</summary>
        public JObject GetResultOrThrow()
        {
            if (_error != null) throw _error;
            return _result ?? new JObject();
        }

        /// <summary>Runs <paramref name="body"/> in a transaction; rolls back on any exception.</summary>
        protected static T InTransaction<T>(Document doc, string name, Func<T> body)
        {
            using (var tx = new Transaction(doc, name))
            {
                tx.Start();
                try
                {
                    var r = body();
                    if (tx.Commit() != TransactionStatus.Committed)
                        throw new RevitCommandException(ErrorCodes.RevitError, "Transaction '" + name + "' did not commit.");
                    return r;
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    throw;
                }
            }
        }
    }
}
