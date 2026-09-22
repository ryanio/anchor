#pragma once

#include <stdint.h>

namespace anchor_request {

// One running request or unread result. The caller owns payload storage and must
// guard every operation with the same lock when a worker and UI share this gate.
// Cancel drops interest immediately, but a running worker retains its slot until
// it completes. Its socket and TLS objects remain owned by that worker.
class Gate {
public:
	using Ticket = uint64_t;

	Ticket start()
	{
		if (busy()) {
			return 0;
		}
		++sequence_;
		if (sequence_ == 0) {
			++sequence_;
		}
		active_ = sequence_;
		wanted_ = active_;
		phase_ = Phase::Running;
		return active_;
	}

	void cancel()
	{
		wanted_ = 0;
		if (phase_ == Phase::Ready) {
			reset();
		}
	}

	// Call under the publication lock, then copy the staged payload before
	// releasing that lock if accepted. A stale completion never releases a newer
	// request's slot, and completing the same ticket twice is harmless.
	bool complete(Ticket ticket)
	{
		if (phase_ != Phase::Running || ticket == 0 || ticket != active_) {
			return false;
		}
		if (!current(ticket)) {
			reset();
			return false;
		}
		phase_ = Phase::Ready;
		return true;
	}

	// Copy the payload under the same lock as this call. A ready result occupies
	// the slot until consumed, so a fast worker cannot overwrite an unread result.
	Ticket consume()
	{
		if (phase_ != Phase::Ready) {
			return 0;
		}
		const Ticket ticket = active_;
		reset();
		return ticket;
	}

	bool current(Ticket ticket) const
	{
		return ticket != 0 && ticket == wanted_;
	}
	bool busy() const
	{
		return phase_ != Phase::Idle;
	}

private:
	enum class Phase : uint8_t { Idle, Running, Ready };
	Phase phase_ = Phase::Idle;
	Ticket sequence_ = 0;
	Ticket active_ = 0;
	Ticket wanted_ = 0;

	void reset()
	{
		phase_ = Phase::Idle;
		active_ = 0;
		wanted_ = 0;
	}
};

}  // namespace anchor_request
