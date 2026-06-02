import * as path from "node:path";
import { IMPACT_LANGUAGE_IDS, LANGUAGE_CAPABILITIES, languageIdsForExtension } from "./languages.ts";

export const IMPACT_LANGUAGES = IMPACT_LANGUAGE_IDS;
const IMPACT_LANGUAGE_SET = new Set(IMPACT_LANGUAGES);

const capabilityById = new Map(LANGUAGE_CAPABILITIES.map((capability) => [capability.id, capability]));

export function changedFileSupportSummary(changedFiles: string[]): Record<string, unknown> {
	const unsupportedImpactFiles: Array<Record<string, unknown>> = [];
	const nonSourceFiles: string[] = [];
	const docFiles: string[] = [];
	const supportedImpactFiles: Array<Record<string, unknown>> = [];
	for (const file of changedFiles) {
		const extension = path.extname(file);
		const languages = languageIdsForExtension(extension);
		if (languages.length === 0) {
			nonSourceFiles.push(file);
			continue;
		}
		const docLanguages = languages.filter((language) => capabilityById.get(language)?.category === "doc");
		const sourceLanguages = languages.filter((language) => capabilityById.get(language)?.category === "source");
		if (sourceLanguages.length === 0) {
			if (docLanguages.length > 0) docFiles.push(file);
			else nonSourceFiles.push(file);
			continue;
		}
		const supported = sourceLanguages.filter((language) => IMPACT_LANGUAGE_SET.has(language));
		if (supported.length > 0) supportedImpactFiles.push({ file, languages: supported });
		else unsupportedImpactFiles.push({ file, languages: sourceLanguages });
	}
	return { supportedImpactLanguages: IMPACT_LANGUAGES, supportedImpactFiles, unsupportedImpactFiles, nonSourceFiles, docFiles };
}
