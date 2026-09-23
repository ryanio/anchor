/* Presses happen inside assert(), so an NDEBUG build would test nothing. */
#undef NDEBUG

#include "../pulse/pulse_keypad_model.h"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

using pulse_keypad::ActionKind;
using pulse_keypad::KeyKind;
using pulse_keypad::Model;
using pulse_keypad::Page;

namespace {

size_t labelsInMap(const Model &model)
{
	size_t labels = 0;
	size_t i = 0;
	for (; model.map()[i][0] != '\0'; i++) {
		if (std::strcmp(model.map()[i], "\n") != 0) labels++;
	}
	return labels;
}

size_t rowsInMap(const Model &model)
{
	size_t rows = 1;
	for (size_t i = 0; model.map()[i][0] != '\0'; i++) {
		if (std::strcmp(model.map()[i], "\n") == 0) rows++;
	}
	return rows;
}

size_t find(const Model &model, const char *label)
{
	for (size_t i = 0, key = 0; model.map()[i][0] != '\0'; i++) {
		if (std::strcmp(model.map()[i], "\n") == 0) continue;
		if (std::strcmp(model.map()[i], label) == 0) return key;
		key++;
	}
	std::fprintf(stderr, "no key labelled %s\n", label);
	assert(false);
	return 0;
}

/* The shortest press sequence from a reset model that types `target`, or empty if none of length
 * four or less does. Replayed on a fresh model every time, so no state leaks between attempts. */
std::vector<size_t> shortestPathTo(char target)
{
	std::vector<std::vector<size_t>> frontier{{}};
	for (int depth = 1; depth <= 4; depth++) {
		std::vector<std::vector<size_t>> next;
		for (const auto &prefix : frontier) {
			Model probe;
			for (size_t press : prefix) probe.press(press);
			for (size_t key = 0; key < probe.keyCount(); key++) {
				std::vector<size_t> path = prefix;
				path.push_back(key);
				Model replay;
				pulse_keypad::Action last{ActionKind::None, 0};
				for (size_t press : path) last = replay.press(press);
				if (last.kind == ActionKind::Insert && last.ch == target) return path;
				if (last.kind == ActionKind::None) next.push_back(path);
			}
		}
		frontier = next;
	}
	return {};
}

}  // namespace

int main()
{
	Model model;

	/* The letter grid: three groups a row, and the same four-key bottom row on every page. */
	assert(model.page() == Page::Letters && !model.choosing());
	assert(model.keyCount() == 13 && labelsInMap(model) == 13 && rowsInMap(model) == 4);
	assert(model.kind(9) == KeyKind::Mode && model.kind(10) == KeyKind::Mode);
	assert(model.kind(11) == KeyKind::Backspace);
	assert(model.kind(12) == KeyKind::Submit);
	assert(model.control(9) && model.control(11) && !model.control(0));

	/* A group opens a chooser, lower case above upper case, and the second tap types and closes. */
	assert(model.press(find(model, "pqrs")).kind == ActionKind::None);
	assert(model.choosing() && model.keyCount() == 9 && rowsInMap(model) == 3);
	assert(std::strcmp(model.map()[0], "p") == 0 && std::strcmp(model.map()[5], "P") == 0);
	auto typed = model.press(find(model, "R"));
	assert(typed.kind == ActionKind::Insert && typed.ch == 'R');
	assert(!model.choosing() && model.page() == Page::Letters && model.keyCount() == 13);

	/* Back leaves a chooser without typing anything. */
	model.press(find(model, "abc"));
	assert(model.choosing());
	assert(model.press(find(model, "Back")).kind == ActionKind::None);
	assert(!model.choosing() && model.page() == Page::Letters);

	/* A symbol group has no upper case row, and a symbol page is one tap from the letters. */
	model.press(find(model, "#+="));
	assert(model.page() == Page::Symbols);
	model.press(find(model, ". , - _"));
	assert(model.choosing() && model.keyCount() == 5 && rowsInMap(model) == 2);
	model.press(find(model, "Back"));
	assert(model.page() == Page::Symbols && !model.choosing());
	model.press(find(model, "abc"));

	/* Space types directly, and only delete repeats while held. */
	typed = model.press(find(model, "space"));
	assert(typed.kind == ActionKind::Insert && typed.ch == ' ' && !model.choosing());
	for (size_t key = 0; key < model.keyCount(); key++) {
		assert(model.repeats(key) == (model.kind(key) == KeyKind::Backspace));
	}
	assert(model.press(find(model, "<-")).kind == ActionKind::Delete);
	assert(model.press(find(model, "OK")).kind == ActionKind::Submit);
	assert(model.press(99).kind == ActionKind::None && model.keyCount() == 13);

	/* Digits type without closing their page, the page keys go where they say, and reset always
	 * lands on letters with no chooser open. */
	model.press(find(model, "123"));
	assert(model.page() == Page::Digits && model.keyCount() == 13);
	typed = model.press(find(model, "7"));
	assert(typed.kind == ActionKind::Insert && typed.ch == '7' && model.page() == Page::Digits);
	model.press(find(model, "abc"));
	assert(model.page() == Page::Letters);
	model.press(find(model, "#+="));
	model.press(find(model, "( ) [ ]"));
	assert(model.choosing() && model.page() == Page::Symbols);
	model.reset();
	assert(model.page() == Page::Letters && !model.choosing());

	/* Caller labels replace the ASCII defaults without changing the layout. */
	pulse_keypad::Labels labels;
	labels.submit = "Join";
	model.setLabels(labels);
	assert(model.keyCount() == 13 && model.kind(find(model, "Join")) == KeyKind::Submit);

	/* Every character WPA2 accepts in a passphrase can be typed. Letters and digits take at most two
	 * taps, and nothing takes more than three. */
	for (int c = 0x20; c <= 0x7E; c++) {
		const std::vector<size_t> path = shortestPathTo((char)c);
		if (path.empty() || path.size() > 3) {
			std::fprintf(stderr, "0x%02x takes %zu presses\n", c, path.size());
			return 1;
		}
		const bool alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
		if (alnum && path.size() > 2) {
			std::fprintf(stderr, "%c takes %zu presses\n", c, path.size());
			return 1;
		}
	}
	return 0;
}
