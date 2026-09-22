#pragma once

#include <stdint.h>

#include "../../common/request_gate.h"

namespace feed {

enum class RequestKind : uint8_t { None, Trending, Portfolio };

struct RequestContext {
  bool configured = false;
  bool connected = false;
  bool radioBusy = false;
  uint32_t networkRevision = 0;
  uint32_t walletRevision = 0;
};

struct Request {
  anchor_request::Gate::Ticket ticket = 0;
  RequestKind kind = RequestKind::None;
  uint32_t networkRevision = 0;
  uint32_t walletRevision = 0;
};

struct Observation {
  bool networkChanged = false;
  bool walletChanged = false;
  bool discarded = false;
};

/*
 * The exact request state machine shared by the loop task and worker.
 *
 * It is deliberately not thread safe. Firmware guards every call with the
 * publication lock, and the host regression exercises this class rather than a
 * second model of it. Cancel only drops interest: the worker keeps ownership of
 * its HTTP and TLS objects and releases the single slot when it completes.
 */
class RequestCoordinator {
public:
  void setWorkerAvailable(bool available) {
    workerAvailable_ = available;
    if (!available) {
      gate_.cancel();
    }
  }

  Observation observe(const RequestContext &next) {
    Observation result;
    if (observed_) {
      result.networkChanged = next.configured != context_.configured ||
                              next.connected != context_.connected ||
                              next.radioBusy != context_.radioBusy ||
                              next.networkRevision != context_.networkRevision;
      result.walletChanged = next.walletRevision != context_.walletRevision;
    }
    context_ = next;
    observed_ = true;
    if (result.networkChanged || result.walletChanged || !usable()) {
      /* `cancel()` resets a ready result immediately. Capture ownership before that transition so
       * the loop also clears the public fetching flag for a result discarded while setup opens. */
      result.discarded = gate_.busy();
      gate_.cancel();
    }
    return result;
  }

  bool canStart() const {
    return workerAvailable_ && observed_ && usable() && !gate_.busy();
  }

  Request start(RequestKind kind) {
    if (kind == RequestKind::None || !canStart())
      return {};
    const anchor_request::Gate::Ticket ticket = gate_.start();
    return {ticket, kind, context_.networkRevision, context_.walletRevision};
  }

  bool current(const Request &request) const {
    return request.ticket != 0 &&
           request.networkRevision == context_.networkRevision &&
           request.walletRevision == context_.walletRevision &&
           gate_.current(request.ticket);
  }

  bool complete(const Request &request) {
    return gate_.complete(request.ticket);
  }

  anchor_request::Gate::Ticket consume() { return gate_.consume(); }
  bool busy() const { return gate_.busy(); }
  bool workerAvailable() const { return workerAvailable_; }

private:
  bool usable() const {
    return context_.configured && context_.connected && !context_.radioBusy;
  }

  anchor_request::Gate gate_;
  RequestContext context_{};
  bool observed_ = false;
  bool workerAvailable_ = false;
};

} // namespace feed
