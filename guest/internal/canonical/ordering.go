package canonical

import (
	"sort"
	"unicode/utf16"
	"unicode/utf8"
)

// sortKeys orders map keys the way the TypeScript implementation does.
//
// `canonicalJson` sorts with JS string comparison, which compares UTF-16 code
// units. Go's sort.Strings compares UTF-8 bytes. The two orders differ when a
// key containing a non-BMP character (encoded as a surrogate pair starting in
// 0xD800..0xDBFF) sits next to a key in U+E000..U+FFFF: UTF-16 puts the astral
// key first, UTF-8 puts it last.
func sortKeys(keys []string) {
	sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
}

// utf16Less reports whether a sorts before b by UTF-16 code unit.
func utf16Less(a, b string) bool {
	for a != "" && b != "" {
		ra, sizeA := utf8.DecodeRuneInString(a)
		rb, sizeB := utf8.DecodeRuneInString(b)
		ua, na := utf16Units(ra)
		ub, nb := utf16Units(rb)
		for i := 0; i < na && i < nb; i++ {
			if ua[i] != ub[i] {
				return ua[i] < ub[i]
			}
		}
		if na != nb {
			// One rune is a code-unit prefix of the other. Only reachable for
			// lone surrogates, which are invalid UTF-8; shorter compares less,
			// as it does in JS.
			return na < nb
		}
		a, b = a[sizeA:], b[sizeB:]
	}
	return len(a) < len(b)
}

// utf16Units returns the UTF-16 code units for r and how many of the two slots
// are used.
func utf16Units(r rune) ([2]uint16, int) {
	if r < 0x10000 {
		return [2]uint16{uint16(r)}, 1
	}
	hi, lo := utf16.EncodeRune(r)
	return [2]uint16{uint16(hi), uint16(lo)}, 2
}
