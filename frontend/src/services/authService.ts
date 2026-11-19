// Authentication service for Microsoft 365 login
// This demonstrates how to integrate with Microsoft Graph API and your backend API

import { PublicClientApplication, AccountInfo, AuthenticationResult } from '@azure/msal-browser';

interface MicrosoftUser {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

// Microsoft Graph Authentication Service
export class MicrosoftAuthService {
  private static msalInstance: PublicClientApplication | null = null;
  private static isInitialized: boolean = false;

  // MSAL configuration
  private static readonly msalConfig = {
    auth: {
      clientId: process.env.REACT_APP_AZURE_CLIENT_ID || '',
      authority: process.env.REACT_APP_AZURE_TENANT_ID 
        ? `https://login.microsoftonline.com/${process.env.REACT_APP_AZURE_TENANT_ID}`
        : 'https://login.microsoftonline.com/common',
      redirectUri: process.env.REACT_APP_REDIRECT_URI || window.location.origin,
    },
    cache: {
      cacheLocation: 'localStorage' as const,
      storeAuthStateInCookie: false,
    },
  };

  // Microsoft Graph scopes
  private static readonly graphScopes = [
    'user.read',
    'profile',
    'openid',
    'email'
  ];

  /**
   * Initialize MSAL instance
   */
  static async initialize(): Promise<PublicClientApplication> {
    if (!this.msalInstance || !this.isInitialized) {
      this.msalInstance = new PublicClientApplication(this.msalConfig);
      await this.msalInstance.initialize();
      this.isInitialized = true;
    }
    return this.msalInstance;
  }

  /**
   * Sign in with Microsoft 365
   */
  static async signIn(): Promise<AuthenticationResult> {
    const msalInstance = await this.initialize();

    try {
      // Clear a stale "interaction in progress" flag (e.g. a popup closed
      // mid-flow in an earlier session) — otherwise loginPopup refuses to
      // start with interaction_in_progress. Safe: the login button is
      // disabled while its own popup is open, so nothing live is cut off.
      sessionStorage.removeItem('msal.interaction.status');

      const loginRequest = {
        scopes: this.graphScopes,
        prompt: 'select_account' as const,
      };

      const response = await msalInstance.loginPopup(loginRequest);
      return response;
    } catch (error) {
      console.error('❌ Microsoft sign-in error:', error);
      if (error instanceof Error) {
        // Provide more specific error messages
        if (error.message.includes('popup')) {
          throw new Error('Popup was blocked. Please allow popups for this site and try again.');
        } else if (error.message.includes('user_cancelled')) {
          throw new Error('Sign-in was cancelled by the user.');
        } else if (error.message.includes('consent_required')) {
          throw new Error('Administrator consent is required. Please contact your administrator.');
        }
      }
      throw error;
    }
  }

  /**
   * Sign out from Microsoft 365
   */
  static async signOut(): Promise<void> {
    const msalInstance = await this.initialize();
    
    try {
      // Local sign-out only: clearing MSAL's cache ends the PMS session without
      // a Microsoft logoutPopup. That popup set MSAL's "interaction in progress"
      // flag and, if it didn't finish cleanly before the redirect to /login,
      // left it behind — blocking the next Microsoft login. The next login
      // still shows the account picker (prompt: 'select_account').

      // Always clear MSAL cache manually to ensure complete logout
      // MSAL stores cache with keys like 'msal.{clientId}.{cacheKey}'
      const clientId = this.msalConfig.auth.clientId;
      const cacheKeys = Object.keys(localStorage);
      cacheKeys.forEach(key => {
        if (key.includes(`msal.${clientId}`) || key.startsWith('msal.')) {
          localStorage.removeItem(key);
        }
      });
      
      // Also clear from sessionStorage
      const sessionCacheKeys = Object.keys(sessionStorage);
      sessionCacheKeys.forEach(key => {
        if (key.includes(`msal.${clientId}`) || key.startsWith('msal.')) {
          sessionStorage.removeItem(key);
        }
      });

      // Drop MSAL's in-memory copy of the account too, not just storage
      await msalInstance.clearCache();
    } catch (error) {
      console.error('Microsoft sign-out error:', error);
      // Even if logout fails, ensure MSAL cache is cleared
      try {
        const clientId = this.msalConfig.auth.clientId;
        const cacheKeys = Object.keys(localStorage);
        cacheKeys.forEach(key => {
          if (key.includes(`msal.${clientId}`) || key.startsWith('msal.')) {
            localStorage.removeItem(key);
          }
        });
        const sessionCacheKeys = Object.keys(sessionStorage);
        sessionCacheKeys.forEach(key => {
          if (key.includes(`msal.${clientId}`) || key.startsWith('msal.')) {
            sessionStorage.removeItem(key);
          }
        });
      } catch (clearError) {
        console.error('Error clearing MSAL cache:', clearError);
      }
      // Don't throw error - we've cleared the cache, which is the important part
    }
  }

  /**
   * Get current Microsoft user account
   */
  static async getCurrentAccount(): Promise<AccountInfo | null> {
    const msalInstance = await this.initialize();
    const accounts = msalInstance.getAllAccounts();
    return accounts.length > 0 ? accounts[0] : null;
  }

  /**
   * Get the ID token for the signed-in account (silently, from MSAL's cache
   * or a background refresh) — sent to the backend to exchange for a PMS token
   */
  static async getIdToken(): Promise<string> {
    const msalInstance = await this.initialize();
    const account = await this.getCurrentAccount();

    if (!account) {
      throw new Error('No active account found');
    }

    const response = await msalInstance.acquireTokenSilent({
      scopes: this.graphScopes,
      account: account,
    });
    return response.idToken;
  }

  /**
   * Get access token for Microsoft Graph
   */
  static async getAccessToken(): Promise<string> {
    const msalInstance = await this.initialize();
    const account = await this.getCurrentAccount();

    if (!account) {
      throw new Error('No active account found');
    }

    try {
      // Try to acquire token silently first
      const response = await msalInstance.acquireTokenSilent({
        scopes: this.graphScopes,
        account: account,
      });

      return response.accessToken;
    } catch (error: any) {
      console.error('Token acquisition error:', error);
      
      // If silent token acquisition fails with interaction_required or other errors,
      // fall back to interactive authentication
      if (error.errorCode === 'interaction_required' || 
          error.errorCode === 'consent_required' ||
          error.errorCode === 'login_required' ||
          error.message?.includes('interaction_required') ||
          error.message?.includes('AADSTS160021') ||
          error.message?.includes('AADSTS50058')) {
        console.log('🔄 Silent token acquisition failed, falling back to interactive authentication...');
        
        try {
          // Fall back to popup-based interactive authentication
          const interactiveResponse = await msalInstance.acquireTokenPopup({
            scopes: this.graphScopes,
            account: account,
          });
          
          return interactiveResponse.accessToken;
        } catch (popupError) {
          console.error('Interactive token acquisition error:', popupError);
          throw new Error('Failed to acquire token. Please try logging in again.');
        }
      }
      
      // For other errors, re-throw as-is
      throw error;
    }
  }

  /**
   * Get Microsoft user profile from Graph API
   * @param accessToken Optional access token. If not provided, will acquire one automatically.
   */
  static async getUserProfile(accessToken?: string): Promise<MicrosoftUser> {
    try {
      // Use provided token or acquire one
      const token = accessToken || await this.getAccessToken();
      
      const response = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch user profile: ${response.status} ${response.statusText}`);
      }

      const user = await response.json();
      
      return {
        id: user.id,
        displayName: user.displayName,
        mail: user.userPrincipalName || user.mail, // Prioritize userPrincipalName (login email) over mail (alias)
        userPrincipalName: user.userPrincipalName,
      };
    } catch (error) {
      console.error('Error fetching user profile:', error);
      throw error;
    }
  }

  /**
   * Check if user is authenticated with Microsoft
   */
  static async isAuthenticated(): Promise<boolean> {
    try {
      const account = await this.getCurrentAccount();
      return account !== null;
    } catch (error) {
      console.error('Error checking authentication status:', error);
      return false;
    }
  }
}

export default MicrosoftAuthService;
