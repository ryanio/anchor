#include "standalone.h"

#include <stdio.h>

namespace {

struct Result {
	int request;
	int value;
};

bool require(bool condition, const char *message)
{
	if (!condition) {
		fprintf(stderr, "%s\n", message);
	}
	return condition;
}

}  // namespace

int main()
{
	using Publication = standalone::RequestPublication<Result>;
	Publication publication;
	bool ok = true;

	const Publication::Ticket a = publication.start();
	ok &= require(a != 0, "A should occupy the request slot");
	ok &= require(publication.start() == 0, "capacity must include a running request");

	// Closing A and opening B invalidates A immediately, but B cannot reuse worker-owned storage while
	// A's transport is still unwinding. Its eventual completion must not become UI-visible.
	publication.cancel();
	ok &= require(!publication.current(a), "close should cancel interest immediately");
	ok &= require(publication.start() == 0, "cancelled running work must retain the slot");
	ok &= require(!publication.complete(a, {1, 10}), "A must be stale after close");
	Result consumed{99, 99};
	ok &= require(!publication.consume(consumed) && consumed.request == 99 && consumed.value == 99,
	              "a stale completion must not mutate loop-owned state");

	const Publication::Ticket b = publication.start();
	ok &= require(b != 0 && b != a, "B should receive a new generation");
	ok &= require(publication.complete(b, {2, 20}), "B completion should be publishable");
	ok &= require(publication.start() == 0, "an unread result must retain the slot");
	ok &= require(publication.consume(consumed), "B should be consumable by the UI task");
	ok &= require(consumed.request == 2 && consumed.value == 20,
	              "the consumed payload must be B rather than stale A");

	// Close and reopen the same identity is still a new generation. Identity equality is not a
	// substitute for lifecycle identity.
	const Publication::Ticket firstOpen = publication.start();
	publication.cancel();
	ok &= require(!publication.complete(firstOpen, {3, 30}),
	              "closed same-identity detail must reject its old completion");
	const Publication::Ticket reopened = publication.start();
	ok &= require(reopened != 0 && reopened != firstOpen,
	              "reopening the same identity must advance generation");
	ok &= require(publication.complete(reopened, {3, 31}), "reopened detail should publish");
	ok &= require(publication.consume(consumed) && consumed.value == 31,
	              "reopened detail must consume only its new result");

	// View exit and network loss use the same cancel path. Cover both running and ready phases.
	const Publication::Ticket exiting = publication.start();
	publication.cancel();
	ok &= require(!publication.complete(exiting, {4, 40}),
	              "a completion after app exit must remain invisible");
	const Publication::Ticket network = publication.start();
	ok &= require(publication.complete(network, {5, 50}), "network result should reach ready phase");
	publication.cancel();
	ok &= require(!publication.consume(consumed), "network loss must discard an unread result");
	ok &= require(!publication.busy(), "discarding ready work should release capacity");

	return ok ? 0 : 1;
}
