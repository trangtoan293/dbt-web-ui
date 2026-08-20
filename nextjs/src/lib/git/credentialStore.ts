export interface GitCredential {
    username: string;
    token: string;
    remoteUrl: string;
    savedAt: number;
    rememberMe: boolean;
}

function clearLegacyCredentialStorage(): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.removeItem('git_credentials');
        sessionStorage.removeItem('git_credentials_session');
    } catch {
        // Ignore storage access failures.
    }
}

export const gitCredentialStore = {
    get(_remoteUrl: string): GitCredential | null {
        clearLegacyCredentialStorage();
        return null;
    },

    save(_remoteUrl: string, _username: string, _token: string, _rememberMe: boolean = false): void {
        clearLegacyCredentialStorage();
    },

    remove(_remoteUrl: string): void {
        clearLegacyCredentialStorage();
    },

    clearAll(): void {
        clearLegacyCredentialStorage();
    },

    has(_remoteUrl: string): boolean {
        clearLegacyCredentialStorage();
        return false;
    },

    getStoredRemotes(): string[] {
        clearLegacyCredentialStorage();
        return [];
    },
};

export default gitCredentialStore;
