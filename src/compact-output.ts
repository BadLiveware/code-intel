import { compactImpact } from "./slices/impact-map/compact.ts";
import { compactLocal } from "./slices/local-map/compact.ts";
import { compactOverview, compactOutline } from "./slices/orientation/compact.ts";
import { compactPostEdit } from "./slices/post-edit-map/compact.ts";
import { compactReadSymbol } from "./slices/read-symbol/compact.ts";
import { compactRoute } from "./slices/repo-route/compact.ts";
import { compactState } from "./slices/state/compact.ts";
import { compactMutation } from "./slices/symbol-mutations/compact.ts";
import { compactSyntax } from "./slices/syntax-search/compact.ts";
import { compactTestMap } from "./slices/test-map/compact.ts";

export type CompactCodeIntelKind = "state" | "overview" | "outline" | "tests" | "route" | "impact" | "local" | "syntax" | "read_symbol" | "post_edit" | "replace_symbol" | "insert_relative";

export function compactCodeIntelOutput(kind: CompactCodeIntelKind, payload: Record<string, unknown>): string {
	if (kind === "state") return compactState(payload);
	if (kind === "overview") return compactOverview(payload);
	if (kind === "outline") return compactOutline(payload);
	if (kind === "tests") return compactTestMap(payload);
	if (kind === "route") return compactRoute(payload);
	if (kind === "impact") return compactImpact(payload);
	if (kind === "local") return compactLocal(payload);
	if (kind === "read_symbol") return compactReadSymbol(payload);
	if (kind === "post_edit") return compactPostEdit(payload);
	if (kind === "replace_symbol") return compactMutation(payload, "replace_symbol");
	if (kind === "insert_relative") return compactMutation(payload, "insert_relative");
	return compactSyntax(payload);
}
