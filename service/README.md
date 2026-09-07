# service

Local read-only data service. **Step 1 of the roadmap** — everything else reads from here.

Responsibilities: one wallet and a few selected collections, cached activity, explicit polling limits,
and token storage in the OS keyring. No component calls the OpenSea API directly; they call this.

Read-only by design. There is no code path here that submits a transaction.
