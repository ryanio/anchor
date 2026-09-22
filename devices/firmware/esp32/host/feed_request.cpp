#include "../app/feed_request.h"

#include <assert.h>

namespace {

feed::RequestContext online(uint32_t network, uint32_t wallets = 1) {
  return {true, true, false, network, wallets};
}

void generationChangeRejectsOldCompletion() {
  feed::RequestCoordinator requests;
  requests.setWorkerAvailable(true);
  requests.observe(online(1));
  const feed::Request first = requests.start(feed::RequestKind::Trending);
  assert(first.ticket != 0);

  const feed::Observation changed = requests.observe(online(2));
  assert(changed.networkChanged);
  assert(!changed.walletChanged);
  assert(changed.discarded);
  assert(!requests.current(first));
  assert(!requests.complete(first));

  const feed::Request second = requests.start(feed::RequestKind::Trending);
  assert(second.ticket != 0);
  assert(second.ticket != first.ticket);
  assert(!requests.complete(first));
  assert(requests.current(second));
  assert(requests.complete(second));
  assert(requests.consume() == second.ticket);
}

void setupDuringFetchCancelsInterest() {
  feed::RequestCoordinator requests;
  requests.setWorkerAvailable(true);
  requests.observe(online(7));
  const feed::Request request = requests.start(feed::RequestKind::Portfolio);

  auto setup = online(7);
  setup.radioBusy = true;
  const feed::Observation changed = requests.observe(setup);
  assert(changed.networkChanged);
  assert(changed.discarded);
  assert(!requests.current(request));
  assert(!requests.complete(request));
}

void readyResultIsCancelledWhenRadioBecomesBusy() {
  feed::RequestCoordinator requests;
  requests.setWorkerAvailable(true);
  requests.observe(online(4));
  const feed::Request old = requests.start(feed::RequestKind::Trending);
  assert(requests.complete(old));

  auto setup = online(4);
  setup.radioBusy = true;
  const feed::Observation changed = requests.observe(setup);
  assert(changed.networkChanged);
  assert(changed.discarded);
  assert(requests.consume() == 0);
  requests.observe(online(4));
  const feed::Request fresh = requests.start(feed::RequestKind::Trending);
  assert(fresh.ticket != 0);
  assert(fresh.ticket != old.ticket);
}

void idleRevisionChangeIsStillReported() {
  feed::RequestCoordinator requests;
  requests.setWorkerAvailable(true);
  requests.observe(online(11));

  const feed::Observation changed = requests.observe(online(12));
  assert(changed.networkChanged);
  assert(!changed.walletChanged);
  assert(!changed.discarded);
  assert(requests.canStart());
}

void disconnectReconnectStartsFreshRequest() {
  feed::RequestCoordinator requests;
  requests.setWorkerAvailable(true);
  requests.observe(online(3));
  const feed::Request beforeDrop = requests.start(feed::RequestKind::Trending);

  auto disconnected = online(3);
  disconnected.connected = false;
  requests.observe(disconnected);
  assert(!requests.complete(beforeDrop));
  assert(!requests.canStart());

  requests.observe(online(3));
  const feed::Request afterReconnect =
      requests.start(feed::RequestKind::Trending);
  assert(afterReconnect.ticket != 0);
  assert(afterReconnect.ticket != beforeDrop.ticket);
}

void allocationFailureIsNotStartable() {
  feed::RequestCoordinator requests;
  requests.observe(online(1));
  requests.setWorkerAvailable(false);
  assert(!requests.workerAvailable());
  assert(!requests.canStart());
  assert(requests.start(feed::RequestKind::Trending).ticket == 0);
}

} // namespace

int main() {
  generationChangeRejectsOldCompletion();
  setupDuringFetchCancelsInterest();
  readyResultIsCancelledWhenRadioBecomesBusy();
  idleRevisionChangeIsStillReported();
  disconnectReconnectStartsFreshRequest();
  allocationFailureIsNotStartable();
  return 0;
}
