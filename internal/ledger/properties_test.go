package ledger

import (
	"fmt"
	"math/rand/v2"
	"strconv"
	"testing"
)

func TestBalanceProperties(t *testing.T) {
	t.Parallel()

	//nolint:gosec // A fixed seed makes the generated test cases reproducible.
	random := rand.New(rand.NewPCG(2025, 11))
	for range 1000 {
		count := random.IntN(119) + 2
		total := int64(count) + random.Int64N(maxAmount-int64(count)+1)
		day := random.IntN(31) + 1
		first := civilDate{year: 2024, month: 2, day: min(day, 29)}
		purchase := installmentPurchase(total, count, day, first.String())

		schedule, err := BuildSchedule(&purchase)
		if err != nil {
			t.Fatal(err)
		}

		checkScheduleProperty(t, schedule, total, count)

		net := random.Int64N(2*maxAmount) - maxAmount

		entries := make([]allocationEntry, len(schedule))
		for i, amount := range schedule {
			amount.AdjustedMinor = random.Int64N(amount.BaseMinor + 1)
			entries[i] = allocationEntry{amount: amount, boughtOn: purchase.BoughtOn}
		}

		checkAllocationProperty(t, entries, net)
	}
}

func checkScheduleProperty(t *testing.T, schedule []ScheduledAmount, total int64, count int) {
	t.Helper()

	if len(schedule) != count {
		t.Fatalf("schedule length = %d, want %d", len(schedule), count)
	}

	var sum int64

	for i, amount := range schedule {
		if amount.BaseMinor <= 0 || amount.AdjustedMinor != amount.BaseMinor ||
			amount.Sequence != i+1 {
			t.Fatalf("invalid base installment: %+v", amount)
		}

		sum += amount.BaseMinor
	}

	if sum != total {
		t.Fatalf("installment sum = %d, want %d", sum, total)
	}
}

func checkAllocationProperty(t *testing.T, entries []allocationEntry, net int64) {
	t.Helper()

	available := max(0, net)
	allocated := available - allocate(entries, net)

	var owed int64
	for _, entry := range entries {
		owed += entry.amount.AdjustedMinor
	}

	if allocated < 0 || allocated > available || allocated != min(owed, available) {
		t.Fatalf("allocated %d, available %d, owed %d", allocated, available, owed)
	}
}

func FuzzParseAmount(f *testing.F) {
	for _, value := range []string{"1.234,56", "1,234.56", "100.000.000", "0.500", "₺1", "", "0"} {
		f.Add(value)
	}

	f.Fuzz(func(t *testing.T, value string) {
		got, err := ParseAmount(value)
		if err != nil {
			if got != 0 {
				t.Fatalf("invalid amount returned %d", got)
			}

			return
		}

		if got < 1 || got > maxAmount {
			t.Fatalf("parsed amount outside range: %d", got)
		}

		canonical := fmt.Sprintf("%d.%02d", got/minorPerMajor, got%minorPerMajor)

		roundTrip, err := ParseAmount(canonical)
		if err != nil || roundTrip != got {
			t.Fatalf("parse of %q = %d, %v, want %d", canonical, roundTrip, err, got)
		}
	})
}

func FuzzValidate(f *testing.F) {
	for _, data := range [][]byte{{}, {0, 1, 2}, {11, 255, 127, 0, 3, 7}, {0, 0, 0, 0, 0, 0}} {
		f.Add(data)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		before, after := baselineRecords(), baselineRecords()
		changes := []Change{
			changeFor(KindUpdate, TypePerson, testPerson),
			changeFor(KindUpdate, TypePurchase, testPurchase),
			changeFor(KindUpdate, TypeRefund, testRefund),
			changeFor(KindUpdate, TypePayout, testPayout),
			changeFor(KindUpdate, TypePayment, testPayment),
			changeFor(KindDelete, TypePurchase, testPurchase),
			changeFor(KindCreate, TypeSettings, SettingsID),
		}
		change := changes[0]

		for _, value := range data[:min(len(data), 32)] {
			mutateLedger(&after, value)
			change = changes[int(value)%len(changes)]
		}

		for _, result := range []*RuleError{
			ValidateRecords(&after, testToday),
			ValidateChange(&before, &after, change, testToday),
		} {
			if result != nil && (result.Code == "" || result.Reason == "") {
				t.Fatalf("incomplete rejection: %+v", result)
			}
		}

		Balances(&after)
	})
}

func mutateLedger(records *Records, value byte) {
	switch value % 12 {
	case 0:
		records.People[0].Archived = !records.People[0].Archived
	case 1:
		records.People[0].Payday = new(int(value))
	case 2:
		records.Purchases[0].TotalMinor = int64(value) - 100
	case 3:
		records.Purchases[0].BoughtOn = strconv.Itoa(int(value))
	case 4:
		records.Purchases[0].Plan = PlanInstallments
		records.Purchases[0].Count = new(int(value))
	case 5:
		records.Refunds[0].PurchaseID = strconv.Itoa(int(value % 2))
	case 6:
		records.Refunds[0].AmountMinor = int64(value) * int64(value)
	case 7:
		records.Payouts[0].PaidOutOn = testFuture
	case 8:
		records.Payouts[0].AmountMinor = int64(value) * int64(value)
	case 9:
		records.Payments[0].PersonID = ""
	case 10:
		records.People = append(records.People, records.People[0])
	case 11:
		records.Settings = nil
	}
}
