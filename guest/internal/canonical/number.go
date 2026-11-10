package canonical

import (
	"math"
	"strconv"
	"strings"
)

// formatNumber renders f exactly as ECMAScript Number::toString(10), which is
// what JSON.stringify emits. Fractions, exponent thresholds and exponent
// padding all differ between Go's strconv and ECMAScript, and any difference
// here changes signature bytes.
//
// The rules, from ECMA-262 6.1.6.1.20, with the shortest round-trip digits
// s (k digits) and n such that the value is s * 10^(n-k):
//
//	k <= n <= 21   -> digits followed by n-k zeros
//	0 < n <= 21    -> digits with "." inserted after n digits
//	-6 < n <= 0    -> "0." followed by -n zeros and the digits
//	otherwise      -> d[.rest]e±(n-1), exponent never zero padded
//
// Non-finite values are unreachable from JSON input, but JSON.stringify renders
// them as null, so the encoder does too rather than emitting invalid JSON.
func formatNumber(f float64) string {
	switch {
	case math.IsNaN(f) || math.IsInf(f, 0):
		return "null"
	case f == 0:
		// Also covers -0, which ECMAScript prints as 0.
		return "0"
	case f < 0:
		return "-" + formatNumber(-f)
	}

	// Shortest round-trip digits in scientific form: "d[.ddd]e±dd".
	sci := strconv.FormatFloat(f, 'e', -1, 64)
	e := strings.LastIndexByte(sci, 'e')
	mantissa, exponent := sci[:e], sci[e+1:]
	exp10, err := strconv.Atoi(exponent)
	if err != nil {
		// Unreachable: FormatFloat always appends a signed decimal exponent.
		return sci
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	n := exp10 + 1 // number of digits before the decimal point

	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}

	var b strings.Builder
	b.Grow(len(digits) + 8)
	b.WriteByte(digits[0])
	if k > 1 {
		b.WriteByte('.')
		b.WriteString(digits[1:])
	}
	b.WriteByte('e')
	if n-1 >= 0 {
		b.WriteByte('+')
		b.WriteString(strconv.Itoa(n - 1))
	} else {
		b.WriteByte('-')
		b.WriteString(strconv.Itoa(1 - n))
	}
	return b.String()
}
