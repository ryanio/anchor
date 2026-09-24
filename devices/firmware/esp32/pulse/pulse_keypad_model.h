#ifndef ANCHOR_PULSE_KEYPAD_MODEL_H
#define ANCHOR_PULSE_KEYPAD_MODEL_H

#include <stddef.h>
#include <stdint.h>

/*
 * The passphrase keypad's layout and state, with no LVGL in it.
 *
 * ## Why this is not `lv_keyboard`
 *
 * This panel is 368 px across on about 29 mm of glass, 322 px to the inch. `lv_keyboard` puts ten or
 * eleven keys on a row, which is 27 to 32 px a key: two and a half millimetres, against the nine or
 * so a fingertip needs. The magnifier drawn above the finger showed which key was pressed but made
 * none of them easier to hit, and the report from the first physical session was that the keyboard was
 * extremely hard to use. No map of a full keyboard fits this width at a usable size.
 *
 * So the keypad is a phone keypad. Three columns and four rows inside the 20 px safe inset, each key
 * 104 x 63 px (8.2 x 5 mm). Letters come in the groups printed on a telephone. Tapping a group replaces the grid with
 * that group's letters, lower case above upper case, three or four to a row and 60 px or more wide.
 * The second tap types the letter and brings the grid back. That is two taps a letter, and both are
 * on targets a thumb can hit, which is the trade this screen needs: a passphrase is typed once per
 * network, and a mistyped one costs a twenty-second failed join.
 *
 * Digits are one tap each on their own page. The 32 ASCII symbols sit in nine groups on a third page,
 * so every printable character WPA2 accepts (0x20 to 0x7E) is reachable. `host/keypad.cpp`
 * walks all 95 of them.
 *
 * ## Why the model is separate
 *
 * The LVGL half (`pulse_keypad.cpp`) only turns this into a button matrix map and forwards presses.
 * Every decision about what a press means is here, where a host compiler can test it without a
 * framebuffer.
 */
namespace pulse_keypad {

enum class Page : uint8_t { Letters, Digits, Symbols };

enum class KeyKind : uint8_t {
	Group,     /* opens a chooser for its characters */
	Char,      /* types one character */
	Mode,      /* moves to the page it names */
	Backspace, /* deletes the character before the cursor */
	Submit,    /* the join or next key */
	Back,      /* leaves a chooser without typing */
};

enum class ActionKind : uint8_t { None, Insert, Delete, Submit };

struct Action {
	ActionKind kind;
	char ch;
};

/* The labels that depend on the caller. The LVGL layer passes its symbol font's glyphs; the host
 * test uses these ASCII defaults. Held by pointer, so they must outlive the model. */
struct Labels {
	const char *backspace = "<-";
	const char *submit = "OK";
	const char *back = "Back";
};

constexpr size_t MAX_KEYS = 16;
/* Every key's label, a "\n" per row break, and the "" terminator LVGL's button matrix expects. */
constexpr size_t MAP_MAX = MAX_KEYS + 8;
constexpr size_t GROUP_MAX = 5;

namespace detail {

struct KeyDef {
	KeyKind kind;
	const char *label;
	/* A group's characters, or a char key's one character. Unused for controls. */
	const char *chars;
	/* Where a mode key goes. Named rather than cycled, so a symbol is one page away from the
	 * letters instead of two. */
	Page target;
};

constexpr int ROWS = 4;
constexpr int COLUMNS_MAX = 4;

/* Every field named, so no compiler has a partial initializer to warn about. */
constexpr KeyDef group(const char *label, const char *chars)
{
	return {KeyKind::Group, label, chars, Page::Letters};
}
constexpr KeyDef key(const char *label, const char *ch) { return {KeyKind::Char, label, ch, Page::Letters}; }
constexpr KeyDef mode(const char *label, Page target) { return {KeyKind::Mode, label, nullptr, target}; }
constexpr KeyDef erase() { return {KeyKind::Backspace, nullptr, nullptr, Page::Letters}; }
constexpr KeyDef submit() { return {KeyKind::Submit, nullptr, nullptr, Page::Letters}; }
constexpr KeyDef none() { return {KeyKind::Group, nullptr, nullptr, Page::Letters}; }

/* The bottom row is the same shape on every page: two keys that change or type, then delete and
 * submit. Delete and submit never move, so a thumb that learns them once keeps them. From the letters
 * both other pages are one tap away, which keeps every symbol within three taps. */
inline const KeyDef (&page(Page p))[ROWS][COLUMNS_MAX]
{
	static const KeyDef letters[ROWS][COLUMNS_MAX] = {
	    {group("abc", "abc"), group("def", "def"), group("ghi", "ghi"), none()},
	    {group("jkl", "jkl"), group("mno", "mno"), group("pqrs", "pqrs"), none()},
	    /* Space is here rather than behind a group because network names use it far more than
	     * passphrases do, and a hidden network's name is typed on this same keypad. */
	    {group("tuv", "tuv"), group("wxyz", "wxyz"), key("space", " "), none()},
	    {mode("123", Page::Digits), mode("#+=", Page::Symbols), erase(), submit()},
	};
	static const KeyDef digits[ROWS][COLUMNS_MAX] = {
	    {key("1", "1"), key("2", "2"), key("3", "3"), none()},
	    {key("4", "4"), key("5", "5"), key("6", "6"), none()},
	    {key("7", "7"), key("8", "8"), key("9", "9"), none()},
	    {mode("abc", Page::Letters), key("0", "0"), erase(), submit()},
	};
	/* All 32 ASCII symbols, in nine groups of three to five. */
	static const KeyDef symbols[ROWS][COLUMNS_MAX] = {
	    {group(". , - _", ".,-_"), group("! ? @", "!?@"), group("# $ %", "#$%"), none()},
	    {group("& * +", "&*+"), group("= ^ ~", "=^~"), group("( ) [ ]", "()[]"), none()},
	    {group("{ } < >", "{}<>"), group("/ \\ |", "/\\|"), group(": ; \" ' `", ":;\"'`"), none()},
	    {mode("abc", Page::Letters), key("space", " "), erase(), submit()},
	};
	return p == Page::Letters ? letters : p == Page::Digits ? digits : symbols;
}

inline bool isLower(char c) { return c >= 'a' && c <= 'z'; }
inline char upper(char c) { return isLower(c) ? (char)(c - ('a' - 'A')) : c; }

}  // namespace detail

class Model {
public:
	Model() { reset(); }

	/* Letters, no chooser open. Called every time the input opens so a page left on symbols for the
	 * last network is not where the next one starts. */
	void reset()
	{
		page_ = Page::Letters;
		group_ = nullptr;
		rebuild();
	}

	void setLabels(const Labels &labels)
	{
		labels_ = labels;
		rebuild();
	}

	Page page() const { return page_; }
	bool choosing() const { return group_ != nullptr; }

	/* The button matrix map for what is showing now: labels, "\n" between rows, "" at the end. The
	 * pointers stay valid until the next call that changes the layout. */
	const char *const *map() const { return map_; }
	size_t keyCount() const { return count_; }
	KeyKind kind(size_t index) const { return index < count_ ? kinds_[index] : KeyKind::Back; }

	/* Backspace repeats while held. Nothing else does: a held letter is a slow tap, not ten. */
	bool repeats(size_t index) const { return index < count_ && kinds_[index] == KeyKind::Backspace; }

	/* A control key, drawn a step darker than the keys that type something. */
	bool control(size_t index) const
	{
		if (index >= count_) return false;
		const KeyKind k = kinds_[index];
		return k == KeyKind::Mode || k == KeyKind::Backspace || k == KeyKind::Back;
	}

	/* What a completed press on `index` means. Changes the layout for group, mode and back keys, and
	 * for a character typed from a chooser, which closes it. Out-of-range presses do nothing. */
	Action press(size_t index)
	{
		if (index >= count_) return {ActionKind::None, 0};
		const char ch = chars_[index];
		switch (kinds_[index]) {
			case KeyKind::Group:
				group_ = groups_[index];
				rebuild();
				return {ActionKind::None, 0};
			case KeyKind::Char:
				if (group_ != nullptr) {
					group_ = nullptr;
					rebuild();
				}
				return {ActionKind::Insert, ch};
			case KeyKind::Mode:
				page_ = targets_[index];
				rebuild();
				return {ActionKind::None, 0};
			case KeyKind::Backspace:
				return {ActionKind::Delete, 0};
			case KeyKind::Submit:
				return {ActionKind::Submit, 0};
			case KeyKind::Back:
				group_ = nullptr;
				rebuild();
				return {ActionKind::None, 0};
		}
		return {ActionKind::None, 0};
	}

private:
	void push(KeyKind kind, const char *label, char ch, const char *group,
	          Page target = Page::Letters)
	{
		if (count_ >= MAX_KEYS || used_ + 2 > MAP_MAX) return;
		kinds_[count_] = kind;
		targets_[count_] = target;
		chars_[count_] = ch;
		groups_[count_] = group;
		count_++;
		map_[used_++] = label;
	}

	void newline()
	{
		if (used_ + 2 <= MAP_MAX) map_[used_++] = "\n";
	}

	void pushChar(char ch)
	{
		/* A chooser's labels are single characters, so they live here rather than in a table. */
		char *cell = cells_[count_ < MAX_KEYS ? count_ : MAX_KEYS - 1];
		cell[0] = ch;
		cell[1] = '\0';
		push(KeyKind::Char, cell, ch, nullptr);
	}

	void rebuild()
	{
		count_ = 0;
		used_ = 0;
		if (group_ != nullptr) {
			bool letters = false;
			for (size_t i = 0; group_[i] != '\0' && i < GROUP_MAX; i++) {
				pushChar(group_[i]);
				letters = letters || detail::isLower(group_[i]);
			}
			if (letters) {
				newline();
				for (size_t i = 0; group_[i] != '\0' && i < GROUP_MAX; i++) {
					pushChar(detail::upper(group_[i]));
				}
			}
			newline();
			push(KeyKind::Back, labels_.back, 0, nullptr);
		} else {
			const auto &rows = detail::page(page_);
			for (int r = 0; r < detail::ROWS; r++) {
				if (r > 0) newline();
				for (int c = 0; c < detail::COLUMNS_MAX; c++) {
					const detail::KeyDef &key = rows[r][c];
					if (key.label == nullptr && key.kind != KeyKind::Backspace &&
					    key.kind != KeyKind::Submit) {
						continue;
					}
					const char *label = key.kind == KeyKind::Backspace ? labels_.backspace
					                    : key.kind == KeyKind::Submit  ? labels_.submit
					                                                   : key.label;
					const char ch = key.kind == KeyKind::Char ? key.chars[0] : 0;
					push(key.kind, label, ch, key.kind == KeyKind::Group ? key.chars : nullptr,
					     key.target);
				}
			}
		}
		map_[used_] = "";
	}

	Page page_ = Page::Letters;
	const char *group_ = nullptr;
	Labels labels_{};
	const char *map_[MAP_MAX + 1]{};
	size_t used_ = 0;
	size_t count_ = 0;
	KeyKind kinds_[MAX_KEYS]{};
	Page targets_[MAX_KEYS]{};
	char chars_[MAX_KEYS]{};
	const char *groups_[MAX_KEYS]{};
	char cells_[MAX_KEYS][2]{};
};

}  // namespace pulse_keypad

#endif /* ANCHOR_PULSE_KEYPAD_MODEL_H */
