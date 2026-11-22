package mcp

import (
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	moneyHelp = "TRY text such as \"1299,90\", \"1.299,90\" or \"5000\" (comma or dot decimals, at most two decimals)"
	dateHelp  = "YYYY-MM-DD"

	peopleRules = "personId comes from list_people or find_person. Never guess a person and never " +
		"create one: if nobody matches, ask the buyer who it is for or tell them to add the person in the app."
)

const listPeopleDescription = "List every person in the ledger, active and archived: id, name, " +
	"aliases (other names the buyer uses for them, such as \"Baba\"), payday (day of month 1 to 31, " +
	"or null) and archived. Call this to learn the people and their ids."

const findPersonDescription = "Find a person by the wording the buyer used. exact is set only when " +
	"the query, compared case-insensitively with Turkish letters folded (Ayşe, AYŞE and ayse are " +
	"the same), equals exactly one person's name or alias: use that person directly. Otherwise exact " +
	"is null and suggestions lists near matches (prefixes and small typos), archived people " +
	"included and flagged. A suggestion is not a match: ask the buyer \"Do you mean X?\" and use it " +
	"only after a yes. After a confirmed suggestion, offer to save the buyer's wording as an alias " +
	"with add_alias, and add it only if they say yes. With no exact match and no suggestion, ask " +
	"the buyer who it is for. Never guess a person and never create one."

const getBalanceDescription = "A person's balance: left to pay, due by today, due in the next month, " +
	"credit, cash shortfall, the status line, and the suggested payment amounts (paymentChips, the " +
	"default first). All amounts are TRY as ...Minor integers (kuruş, 100 = 1 TL) and formatted " +
	"text. " + peopleRules

const getStatementDescription = "A person's itemized statement: balance summary plus purchases with " +
	"price, refunds, what is left and the installment schedule with paid and remaining amounts and " +
	"overdue flags. By default only purchases with something left are listed, with only their " +
	"unpaid installments; set includePaid to see everything. since (" + dateHelp + ") keeps purchases " +
	"bought on or after that date. " + peopleRules

const getOverviewDescription = "Every active person's balance summary, most urgent first (due by " +
	"today, then left to pay), plus totals over everyone, archived people included. Use it for " +
	"\"who owes what\" questions."

const comingUpDescription = "The next installments and due dates falling within the coming month, " +
	"across everyone, soonest first (at most eight), with person and item names."

const findPurchasesDescription = "Search purchases. query matches part of the item name " +
	"(case-insensitive, Turkish letters folded); personId, since and until (" + dateHelp + ", on " +
	"boughtOn, inclusive) narrow it. Newest first, at most 50. Each result has refundableMinor, " +
	"the most a shop refund may still return. Use it to find a purchaseId for add_refund."

const checkPurchasesDescription = "Duplicate check. Before recording purchases from a screenshot or " +
	"order list, call this once with every item (item, price, boughtOn). For each it returns " +
	"existing purchases of ANY person with the same price bought within 3 days either way. Tell the " +
	"buyer about every possible duplicate and let them decide before recording; an empty list " +
	"means no duplicate found."

const addPurchaseDescription = "Record something the buyer bought for a person. Ask who it is for " +
	"and whether it is paid once or in installments for each item unless the buyer already said; " +
	"never guess a missing person or plan. Before writing, state what you will record, including any " +
	"defaults you rely on (bought today, 6 installments, first due date), and get the buyer's " +
	"go-ahead if you assumed anything. For screenshots run check_purchases first. " +
	peopleRules + " price is the full price of the purchase as " + moneyHelp + ". " +
	"boughtOn defaults to today (ledger time zone) and cannot be in the future. plan is \"once\" " +
	"(default) or \"installments\". Once: dueDate is optional, a date or \"payday\" (the person's " +
	"next payday, only if they have one), \"endOfMonth\" or \"inTwoWeeks\"; with no dueDate the " +
	"purchase is undated and shows as due when they can. Installments: count is 2 to 120 (default " +
	"6), firstDue defaults to the person's first payday on or after today, or the same day next " +
	"month when they have no payday; an explicit firstDue sets the due day to its day, and " +
	"lastDayOfMonth=true with a firstDue that is a month's last day makes every installment fall " +
	"on the last day of its month. dueDate is not allowed with installments, nor count, firstDue " +
	"or lastDayOfMonth with once. A purchase for an archived person is rejected. Returns the " +
	"purchase with its schedule and the person's new balance."

const recordPaymentDescription = "Record money a person paid the buyer (for example \"Dad sent " +
	"5000 TL\"). Payments are not tied to a purchase: the ledger applies them to what is due " +
	"oldest first. " + peopleRules + " amount is " + moneyHelp + ". paidOn defaults to today and " +
	"cannot be in the future. State what you will record before writing if anything was assumed. " +
	"Returns the payment and the person's new balance."

const addRefundDescription = "Record a shop refund: money the shop returned for a purchase, which " +
	"lowers what the person owes for it. It is not a payment from the person. purchaseId comes " +
	"from get_statement or find_purchases. amount is " + moneyHelp + " and at most the purchase's " +
	"refundableMinor. refundedOn defaults to today, cannot be in the future and cannot be before " +
	"the purchase date. Returns the refund and the purchase's new view."

const addAliasDescription = "Save another name for a person (for example \"Annem\") so the buyer's " +
	"wording matches them next time. ASK THE BUYER FIRST and call this only after they say yes. " +
	"A person has at most 20 aliases of up to 40 characters; an alias cannot equal their own name " +
	"or another person's name or alias (the call is rejected with alias_conflict). Returns the " +
	"updated person. " + peopleRules

const removeAliasDescription = "Remove one of a person's aliases (matched like names: case and " +
	"Turkish letters ignored). ASK THE BUYER FIRST and call this only after they say yes. " +
	"Returns the updated person. " + peopleRules

const undoDescription = "Delete a purchase, payment or refund you recorded by mistake. Only works " +
	"for records created through this connector, not edited since, and created less than 24 hours " +
	"ago; a purchase that has shop refunds cannot be deleted. Anything else must be corrected by " +
	"the buyer in the app. Ask the buyer before undoing. recordId is the id returned when it was " +
	"created."

func newTool(name, description string, annotations *sdk.ToolAnnotations) *sdk.Tool {
	return &sdk.Tool{
		Meta: nil, Name: name, Title: "", Description: description, Icons: nil,
		InputSchema: nil, OutputSchema: nil, Annotations: annotations,
	}
}

func annotate(
	title string,
	readOnly bool,
	destructive *bool,
	idempotent bool,
) *sdk.ToolAnnotations {
	return &sdk.ToolAnnotations{
		Title: title, ReadOnlyHint: readOnly, DestructiveHint: destructive,
		IdempotentHint: idempotent, OpenWorldHint: new(false),
	}
}

func (svc *service) register(server *sdk.Server) {
	read := func(title string) *sdk.ToolAnnotations { return annotate(title, true, nil, true) }
	add := func(title string) *sdk.ToolAnnotations { return annotate(title, false, new(false), false) }

	sdk.AddTool(
		server,
		newTool("list_people", listPeopleDescription, read("List people")),
		svc.listPeople,
	)
	sdk.AddTool(
		server,
		newTool("find_person", findPersonDescription, read("Find a person")),
		svc.findPerson,
	)
	sdk.AddTool(
		server,
		newTool("get_balance", getBalanceDescription, read("Get a balance")),
		svc.getBalance,
	)
	sdk.AddTool(server, newTool(
		"get_statement", getStatementDescription, read("Get a statement")), svc.getStatement)
	sdk.AddTool(server, newTool(
		"get_overview", getOverviewDescription, read("Get the overview")), svc.getOverview)
	sdk.AddTool(server, newTool("coming_up", comingUpDescription, read("Coming up")), svc.comingUp)
	sdk.AddTool(server, newTool(
		"find_purchases", findPurchasesDescription, read("Find purchases")), svc.findPurchases)
	sdk.AddTool(server, newTool(
		"check_purchases", checkPurchasesDescription, read("Check for duplicate purchases")),
		svc.checkPurchases)
	sdk.AddTool(server, newTool(
		"add_purchase", addPurchaseDescription, add("Add a purchase")), svc.addPurchase)
	sdk.AddTool(server, newTool(
		"record_payment", recordPaymentDescription, add("Record a payment")), svc.recordPayment)
	sdk.AddTool(server, newTool(
		"add_refund", addRefundDescription, add("Add a shop refund")), svc.addRefund)
	sdk.AddTool(
		server,
		newTool("add_alias", addAliasDescription, add("Add an alias")),
		svc.addAlias,
	)
	sdk.AddTool(server, newTool(
		"remove_alias", removeAliasDescription, annotate("Remove an alias", false, nil, true)),
		svc.removeAlias)
	sdk.AddTool(server, newTool(
		"undo", undoDescription, annotate("Undo a record", false, new(true), false)), svc.undo)
}
