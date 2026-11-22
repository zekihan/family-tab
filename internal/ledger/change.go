package ledger

import "slices"

func validateChange(before, after *Records, change Change, today string) *RuleError {
	if before == nil {
		before = new(Records)
	}

	if before.Settings == nil && (change.RecordType != TypeSettings || change.Kind != KindCreate) {
		return rule(CodeNotSetup, "ledger setup is required")
	}

	if after == nil {
		return rule(CodeInvalid, "missing after-records")
	}

	if _, ok := parseDate(today); !ok {
		return rule(CodeInvalid, "invalid today date")
	}

	if change.RecordType == TypeSettings {
		return validateSettingsChange(before, after, change)
	}

	key := recordKey{change.RecordType, change.RecordID}
	previous := findRecord(before, key)

	switch change.Kind {
	case KindCreate:
		if idInUse(before, key.id) {
			return rule(CodeDuplicateID, "record ID is already in use")
		}
	case KindUpdate, KindDelete:
		if previous == nil {
			return rule(CodeConflict, "record no longer exists")
		}
	default:
		return rule(CodeInvalid, "unknown change kind")
	}

	if change.Kind == KindDelete {
		return validateDeletion(after, key)
	}

	rules := indexRecordRules(after, today)

	return validateRecordChange(after, rules, rules.rows[key], previous, change.AlreadyReturned)
}

func findRecord(records *Records, target recordKey) any {
	for key, row := range recordEntries(records) {
		if key == target {
			return row
		}
	}

	return nil
}

func idInUse(records *Records, id string) bool {
	for key := range recordEntries(records) {
		if key.id == id {
			return true
		}
	}

	return false
}

func validateSettingsChange(before, after *Records, change Change) *RuleError {
	if change.RecordID != SettingsID {
		return rule(CodeInvalid, "settings must use the ledger ID")
	}

	switch change.Kind {
	case KindCreate:
		if before.Settings != nil || idInUse(before, SettingsID) {
			return rule(CodeDuplicateID, "settings ID is already in use")
		}
	case KindUpdate:
		if after.Settings != nil &&
			(after.Settings.ID != before.Settings.ID || after.Settings.Currency != before.Settings.Currency) {
			return rule(CodeInvalid, "only the settings time zone can change")
		}
	default:
		return rule(CodeInvalid, "settings cannot be deleted")
	}

	if after.Settings == nil {
		return rule(CodeInvalid, "missing ledger settings")
	}

	return validateSettings(after.Settings)
}

func validateRecordChange(
	after *Records, rules recordRules, row, previous any, alreadyReturned bool,
) *RuleError {
	err := rules.validate(row, previous)
	if err != nil {
		return err
	}

	switch value := row.(type) {
	case *Purchase:
		old := asRecord[*Purchase](previous)

		return rules.validatePurchaseChange(value, old)
	case *Refund:
		old := asRecord[*Refund](previous)
		if old != nil && value.PurchaseID != old.PurchaseID {
			return rule(CodeInvalid, "refund purchase cannot change")
		}

		return rules.validateRefundSum(rules.purchase(value.PurchaseID))
	case *Payout:
		old := asRecord[*Payout](previous)
		if !alreadyReturned && (old == nil ||
			value.AmountMinor > old.AmountMinor || value.PersonID != old.PersonID) {
			return validatePayoutCredit(after, value)
		}
	}

	return nil
}

func (rules recordRules) validatePurchaseChange(purchase, previous *Purchase) *RuleError {
	err := rules.validateRefundSum(purchase)
	if err != nil {
		return err
	}

	for _, refund := range rules.refunds[purchase.ID] {
		err := rules.validateDate(refund.RefundedOn, false)
		if err != nil {
			return err
		}

		if refund.RefundedOn < purchase.BoughtOn {
			return rule(CodeInvalid, "refund date precedes purchase")
		}
	}

	if (previous == nil || purchase.PersonID != previous.PersonID) &&
		rules.person(purchase.PersonID).Archived {
		return rule(CodeArchivedPerson, "purchase must belong to an active person")
	}

	return nil
}

func validatePayoutCredit(after *Records, payout *Payout) *RuleError {
	withoutPayout := *after

	withoutPayout.Payouts = make([]Payout, 0, len(after.Payouts)-1)
	for _, other := range after.Payouts {
		if other.ID != payout.ID {
			withoutPayout.Payouts = append(withoutPayout.Payouts, other)
		}
	}

	if payout.AmountMinor > balances(&withoutPayout)[payout.PersonID].Credit {
		return rule(CodePayoutExceedsCredit, "payout exceeds available credit")
	}

	return nil
}

func validateDeletion(after *Records, key recordKey) *RuleError {
	if findRecord(after, key) != nil {
		return rule(CodeInvalid, "deleted record is still present")
	}

	switch key.kind {
	case TypePurchase:
		var blocking []string

		for _, refund := range after.Refunds {
			if refund.PurchaseID == key.id {
				blocking = append(blocking, refund.ID)
			}
		}

		if len(blocking) > 0 {
			slices.Sort(blocking)

			return rule(CodePurchaseHasRefunds, "purchase still has refunds", blocking...)
		}
	case TypePerson:
		blocking := personReferences(after, key.id)
		if len(blocking) > 0 {
			slices.Sort(blocking)

			return rule(CodePersonHasRecords, "person still has records", blocking...)
		}
	}

	return nil
}

func personReferences(records *Records, personID string) []string {
	var ids []string

	for i := range records.Purchases {
		purchase := &records.Purchases[i]
		if purchase.PersonID == personID {
			ids = append(ids, purchase.ID)
		}
	}

	for _, payment := range records.Payments {
		if payment.PersonID == personID {
			ids = append(ids, payment.ID)
		}
	}

	for _, payout := range records.Payouts {
		if payout.PersonID == personID {
			ids = append(ids, payout.ID)
		}
	}

	return ids
}
