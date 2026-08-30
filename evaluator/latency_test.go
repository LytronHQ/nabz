package main

import "testing"

func fill(n, v int) []int {
	s := make([]int, n)
	for i := range s {
		s[i] = v
	}
	return s
}

func TestP95(t *testing.T) {
	cases := []struct {
		name   string
		values []int
		want   int
	}{
		{"empty", nil, 0},
		{"single", []int{42}, 42},
		{"1..20 -> 19th value", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20}, 19},
		{"unsorted input is sorted", []int{50, 10, 30, 20, 40}, 50}, // n=5 -> p95 is the max
		{"outlier lands at p95 for n=10", []int{10, 10, 10, 10, 10, 10, 10, 10, 10, 9999}, 9999},
		{"outlier excluded below p95 for n=40", append(append([]int{}, fill(39, 10)...), 9999), 10},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := p95(c.values); got != c.want {
				t.Fatalf("p95(%v) = %d, want %d", c.values, got, c.want)
			}
		})
	}
}
