/* Checks happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include "../pulse/pulse_companion_model.h"

#include <cassert>
#include <cstring>

using pulse_companion::Inputs;
using pulse_companion::Mood;

namespace {

Inputs online()
{
	Inputs in;
	in.wifiConfigured = true;
	in.online = true;
	return in;
}

bool says(const Inputs &in, size_t index, const char *expected)
{
	char out[112];
	pulse_companion::line(in, index, out, sizeof(out));
	return std::strcmp(out, expected) == 0;
}

}  // namespace

int main()
{
	/* No Wi-Fi saved: lost, whatever else it knows, and it asks to be set up. */
	Inputs in;
	in.havePortfolio = true;
	in.total = "$3,125";
	assert(pulse_companion::moodFor(in) == Mood::Lost);
	assert(pulse_companion::lineCount(in) == 1);
	assert(says(in, 0, "I need Wi-Fi.\nTap me to set it up."));

	/* Saved but not connected, or connected with stale data: sleepy, and it says how old things are. */
	in.wifiConfigured = true;
	assert(pulse_companion::moodFor(in) == Mood::Sleepy);
	in.age = "4m ago";
	assert(says(in, 0, "Looking for Wi-Fi...\n4m ago"));
	in = online();
	in.stale = true;
	assert(pulse_companion::moodFor(in) == Mood::Sleepy);

	/* Online with nothing yet: curious while asking, content when idle. */
	in = online();
	in.fetching = true;
	assert(pulse_companion::moodFor(in) == Mood::Curious);
	assert(says(in, 0, "Asking OpenSea...\none moment"));
	in.fetching = false;
	assert(pulse_companion::moodFor(in) == Mood::Content);

	/* The portfolio's day decides the mood, and "--" is no reading rather than a flat day. */
	in = online();
	in.havePortfolio = true;
	in.total = "$3,125";
	in.change = "+3.54%";
	in.changePositive = true;
	in.covered = 6;
	in.configured = 6;
	assert(pulse_companion::moodFor(in) == Mood::Happy);
	assert(says(in, 0, "Your wallets: $3,125 (6 of 6)\n+3.54% today"));
	in.change = "-4.12%";
	in.changePositive = false;
	assert(pulse_companion::moodFor(in) == Mood::Worried);
	in.change = "--";
	assert(pulse_companion::moodFor(in) == Mood::Content);
	assert(says(in, 0, "Your wallets: $3,125 (6 of 6)\nno 24h change yet"));

	/* A partial answer says so, and a single wallet does not print a coverage label at all. */
	in.change = "+2.95%";
	in.changePositive = true;
	in.covered = 4;
	assert(says(in, 0, "Your wallets: $3,125 (4 of 6)\n+2.95% today"));
	in.covered = 1;
	in.configured = 1;
	assert(says(in, 0, "Your wallets: $3,125\n+2.95% today"));

	/* A tap steps from the portfolio to the top trending token and back. */
	in.haveTrending = true;
	in.topSymbol = "STONK";
	in.topPrice = "$0.2400";
	in.topChange = "-4.58%";
	assert(pulse_companion::lineCount(in) == 2);
	assert(says(in, 1, "STONK is trending\n$0.2400, -4.58% today"));
	assert(says(in, 2, "Your wallets: $3,125\n+2.95% today"));

	/* With no portfolio the trending token decides the mood and is the only line. */
	in.havePortfolio = false;
	in.topPositive = false;
	assert(pulse_companion::moodFor(in) == Mood::Worried);
	assert(pulse_companion::lineCount(in) == 1);
	assert(says(in, 0, "STONK is trending\n$0.2400, -4.58% today"));

	/* A short buffer truncates rather than overruns. */
	char small[8];
	pulse_companion::line(in, 0, small, sizeof(small));
	assert(std::strcmp(small, "STONK i") == 0);
	return 0;
}
