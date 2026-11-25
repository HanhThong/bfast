import type { SettingsService } from '../settings/settingsService';
import type { TestResultsContext } from './testResultsStore';

/**
 * The results store's view of the settings — `settingsTrackerContext`'s twin.
 * Both are read at call time, so the store can be built before `bfast.json`
 * has been read and follows a change of `tests.resultsFolder` on the next run.
 */
export function settingsTestResultsContext(settings: SettingsService): TestResultsContext {
	return {
		rootUri: () => {
			const current = settings.current;
			return current ? settings.testResultsFolderUri(current) : undefined;
		},
		author: () => settings.current?.userName?.trim() || 'unknown'
	};
}
