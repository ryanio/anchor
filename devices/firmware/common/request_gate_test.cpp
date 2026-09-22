#include "request_gate.h"

#include <cassert>

int main()
{
	using anchor_request::Gate;
	Gate gate;
	assert(!gate.busy());
	assert(gate.consume() == 0);
	assert(!gate.complete(0));

	const auto first = gate.start();
	assert(first != 0 && gate.current(first));
	assert(gate.start() == 0);
	gate.cancel();
	assert(!gate.current(first));
	assert(gate.busy());  // The cancelled worker still owns its request storage.
	assert(gate.start() == 0);
	assert(!gate.complete(first));
	assert(!gate.busy());

	const auto second = gate.start();
	assert(second != first);  // Reopening the same item must use a new generation.
	assert(!gate.complete(first));
	assert(gate.current(second) && gate.busy());
	assert(gate.complete(second));
	assert(!gate.complete(second));
	assert(gate.start() == 0);  // An unread result cannot be overwritten.
	assert(gate.consume() == second);
	assert(!gate.busy() && !gate.current(second));
	assert(gate.consume() == 0);

	const auto third = gate.start();
	assert(gate.complete(third));
	gate.cancel();  // Navigating away after completion also discards the result.
	assert(gate.consume() == 0 && !gate.busy());
	const auto fourth = gate.start();
	assert(fourth != third && gate.current(fourth));
	gate.cancel();
	gate.cancel();
	assert(!gate.complete(third));
	assert(gate.busy());
	assert(!gate.complete(fourth));
	assert(!gate.busy());
}
