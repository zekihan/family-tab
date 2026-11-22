package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRun(t *testing.T) {
	t.Parallel()

	input := strings.NewReader(`{"cases":[{
		"today":"2024-02-29","timeZone":"UTC",
		"records":{
			"people":[{"id":"person","name":"Someone","payday":29}],
			"purchases":[{"id":"purchase","personId":"person","item":"Item","totalMinor":5,
				"boughtOn":"2024-02-01","plan":"installments","count":2,"firstDue":"2024-02-29","dueDay":31}],
			"refunds":[{"id":"refund","purchaseId":"purchase","amountMinor":1,"refundedOn":"2024-02-29"}],
			"payments":[{"id":"payment","personId":"person","amountMinor":10,"paidOn":"2024-02-29"}],
			"payouts":[{"id":"payout","personId":"person","amountMinor":3,"paidOutOn":"2024-02-29"}]
		},
		"changes":[
			{"op":{"kind":"update","recordType":"purchase","recordId":"purchase","patch":{"dueDay":29}}},
			{"op":{"kind":"update","recordType":"purchase","recordId":"purchase","patch":{"dueDay":null}}},
			{"op":{"kind":"update","recordType":"purchase","recordId":"purchase","patch":{"note":"edited"}}},
			{"op":{"kind":"delete","recordType":"purchase","recordId":"purchase"}},
			{"op":{"kind":"create","recordType":"payout","recordId":"new","record":{
				"id":"new","personId":"person","amountMinor":4,"paidOutOn":"2024-02-29"}}}
		],
		"amounts":["1.234,5",",5"]
	}]}`)

	var output bytes.Buffer

	err := run(input, &output)
	if err != nil {
		t.Fatal(err)
	}

	expected := `[{
		"schedules":{"purchase":{
			"base":[
				{"purchaseId":"purchase","sequence":1,"baseMinor":3,"adjustedMinor":3,"dueOn":"2024-02-29"},
				{"purchaseId":"purchase","sequence":2,"baseMinor":2,"adjustedMinor":2,"dueOn":"2024-03-31"}
			],
			"adjusted":[
				{"purchaseId":"purchase","sequence":1,"baseMinor":3,"adjustedMinor":3,"dueOn":"2024-02-29"},
				{"purchaseId":"purchase","sequence":2,"baseMinor":2,"adjustedMinor":1,"dueOn":"2024-03-31"}
			]
		}},
		"people":{"person":{
			"personId":"person","paymentsReceived":10,"cashReturned":3,"netReceipts":7,"credit":3,"cashShortfall":0
		}},
		"valid":null,
		"changes":[
			{"code":null,"recordsCode":null},
			{"code":"invalid","recordsCode":"invalid"},
			{"code":null,"recordsCode":null},
			{"code":"purchase_has_refunds","recordsCode":"not_found"},
			{"code":"payout_exceeds_credit","recordsCode":null}
		],
		"amounts":[123450,null]
	}]`

	assertJSON(t, output.Bytes(), []byte(expected))
}

func assertJSON(t *testing.T, output, expected []byte) {
	t.Helper()

	var got, want any

	err := json.Unmarshal(output, &got)
	if err != nil {
		t.Fatal(err)
	}

	err = json.Unmarshal(expected, &want)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %s, want %s", output, expected)
	}
}
