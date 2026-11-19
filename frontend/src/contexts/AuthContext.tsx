import React, { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { MicrosoftAuthService } from '../services/authService';
import ApiService from '../services/apiService';
import JWTUtils from '../utils/jwtUtils';
import {
  INACTIVITY_TIMEOUT_MS,
  isSessionTimedOut,
  clearSessionCredentials,
  redirectToLoginAfterTimeout,
} from '../utils/sessionTimeout';
import { type User, type AuthState, type AuthContextType } from '../types/user';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Builds the app's User from the backend token's claims. Every sign-in path
// (Microsoft, page-reload restore) goes through here so they all
// carry the same role flags. auth_method is stamped by the backend; tokens
// issued before it existed have none and are treated as manual.
const userFromClaims = (flatClaims: any): User => ({
  id: flatClaims.user_id || 'unknown',
  name: flatClaims.name,
  email: flatClaims.email,
  title: flatClaims.title || 'User',
  designation: flatClaims.designation || undefined,
  department: flatClaims.department || undefined,
  employeeId: flatClaims.employee_id || undefined,
  hasTeam: flatClaims.has_team || false,
  isHR: flatClaims.is_hr || false,
  isCDO: flatClaims.is_cdo || false,
  role: flatClaims.role || 'user', // Use mapped role name from JWT
  view: flatClaims.view || true, // Permissions are at root level in JWT
  edit: flatClaims.edit || true,
  settings: flatClaims.settings || true,
  authMethod: flatClaims.auth_method === 'microsoft' ? 'microsoft' : 'manual'
});

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const location = useLocation();
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    user: null
  });
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const INACTIVITY_TIMEOUT = INACTIVITY_TIMEOUT_MS;

  // Redirect before child useEffects run (e.g. dashboard/edit API fetches on refresh).
  useLayoutEffect(() => {
    if (isSessionTimedOut()) {
      redirectToLoginAfterTimeout();
    }
  }, []);

  // Check if current route is a public route (no authentication required)
  const isPublicRoute = useCallback((pathname: string): boolean => {
    // Keep in sync with the routes outside ProtectedLayout in App.tsx.
    const publicRoutes = [
      '/login',
      '/login/callback',
    ];

    const path = pathname.toLowerCase();
    return publicRoutes.some((route) => path.startsWith(route.toLowerCase()));
  }, []);

  // Check for existing manual login session
  const checkManualAuth = async (): Promise<User | null> => {
        // Use sessionStorage instead of localStorage so session clears when tab closes
        const authToken = sessionStorage.getItem('authToken') || localStorage.getItem('authToken');
        
        if (authToken) {
          try {
            // Structural/expiry check FIRST (real signature verification only
            // happens server-side, on every authenticated request)
            const isTokenValid = JWTUtils.isTokenStructurallyValid(authToken);
            if (!isTokenValid) {
              console.log('🔐 Token invalid or expired, clearing stored credentials');
              sessionStorage.removeItem('authToken');
              localStorage.removeItem('authToken');
              sessionStorage.removeItem('manualAuthUser');
              localStorage.removeItem('manualAuthUser');
              sessionStorage.removeItem('lastActivity');
              localStorage.removeItem('lastActivity');
              return null;
            }

            // Note: Session timeout is now checked in initAuth before calling checkManualAuth
            // So we don't need to check it here to avoid duplicate logic

            // Always try to get fresh data from token first, then fallback to stored user
            const flatClaims = JWTUtils.getFlatClaims(authToken);
        
         if (flatClaims && flatClaims.email && flatClaims.name) {
           const user = userFromClaims(flatClaims);
          
          
          // Store the fresh user data (prefer sessionStorage)
          sessionStorage.setItem('manualAuthUser', JSON.stringify(user));
          localStorage.setItem('manualAuthUser', JSON.stringify(user));
          return user;
        }

        // Fallback to stored user if token extraction fails
        const storedUser = sessionStorage.getItem('manualAuthUser') || localStorage.getItem('manualAuthUser');
        if (storedUser) {
          const user = JSON.parse(storedUser);
          return user;
        }

      } catch (error) {
        // Clear invalid stored data
        sessionStorage.removeItem('manualAuthUser');
        localStorage.removeItem('manualAuthUser');
        sessionStorage.removeItem('authToken');
        localStorage.removeItem('authToken');
      }
    }
    return null;
  };

  const logout = useCallback(async () => {
    try {
      // Clear manual auth data from both sessionStorage and localStorage
      sessionStorage.removeItem('authToken');
      localStorage.removeItem('authToken');
      sessionStorage.removeItem('manualAuthUser');
      localStorage.removeItem('manualAuthUser');
      sessionStorage.removeItem('lastActivity');
      localStorage.removeItem('lastActivity');
      
      // Sign out from Microsoft if authenticated via Microsoft
      if (authState.user?.authMethod === 'microsoft') {
        try {
          await MicrosoftAuthService.signOut();
        } catch (msalError) {
          console.error('Microsoft logout error:', msalError);
          // Continue with logout even if Microsoft signOut fails
          // The cache clearing in signOut should still work
        }
      }
      
      // Single full reload straight to /login. Deliberately no setAuthState
      // first: storage is already cleared above (the reload reads auth from
      // there), and flipping isAuthenticated would make SecureRoute draw the
      // Login screen in place just before the reload draws it again — the
      // login page appearing twice. replace() also drops the protected page
      // from history, so Back after logout doesn't return to it.
      window.location.replace('/login');
    } catch (error) {
      // Force logout by clearing everything
      sessionStorage.removeItem('authToken');
      localStorage.removeItem('authToken');
      sessionStorage.removeItem('manualAuthUser');
      localStorage.removeItem('manualAuthUser');
      sessionStorage.removeItem('lastActivity');
      localStorage.removeItem('lastActivity');
      
      // Also clear MSAL cache manually as fallback
      try {
        const cacheKeys = Object.keys(localStorage);
        cacheKeys.forEach(key => {
          if (key.startsWith('msal.')) {
            localStorage.removeItem(key);
          }
        });
        const sessionCacheKeys = Object.keys(sessionStorage);
        sessionCacheKeys.forEach(key => {
          if (key.startsWith('msal.')) {
            sessionStorage.removeItem(key);
          }
        });
      } catch (clearError) {
        console.error('Error clearing MSAL cache:', clearError);
      }

      // Same single reload as above.
      window.location.replace('/login');
    }
  }, [authState.user?.authMethod]);

  // Expose initAuth for manual refresh
  const initAuth = useCallback(async () => {
    try {
      // Skip authentication checks for public routes
      if (isSessionTimedOut()) {
        clearSessionCredentials();
        setAuthState({
          isAuthenticated: false,
          isLoading: false,
          user: null
        });
        window.location.replace('/login');
        return;
      }

      if (isPublicRoute(location.pathname)) {
        setAuthState({
          isAuthenticated: false,
          isLoading: false,
          user: null
        });
        return;
      }

      // First check for manual authentication
      const manualUser = await checkManualAuth();
      if (manualUser) {
        // Update last activity when authentication succeeds
        const now = Date.now().toString();
        sessionStorage.setItem('lastActivity', now);
        localStorage.setItem('lastActivity', now);
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          user: manualUser
        });
        return;
      }

      // Then check Microsoft authentication
      const isMicrosoftAuthenticated = await MicrosoftAuthService.isAuthenticated();
      if (isMicrosoftAuthenticated) {
        try {
          // Get current Microsoft user profile first to verify identity
          const microsoftUser = await MicrosoftAuthService.getUserProfile();
          const currentMicrosoftEmail = microsoftUser.mail || microsoftUser.userPrincipalName;
          
          // First check if we have a stored backend token (from previous Microsoft login)
          const storedToken = sessionStorage.getItem('authToken') || localStorage.getItem('authToken');
          const storedUser = sessionStorage.getItem('manualAuthUser') || localStorage.getItem('manualAuthUser');
          
          if (storedToken && storedUser) {
            // Verify token is still valid
            const isTokenValid = JWTUtils.isTokenStructurallyValid(storedToken);
            if (isTokenValid) {
              // Extract email from stored token to verify it matches current Microsoft user
              const storedTokenClaims = JWTUtils.getFlatClaims(storedToken);
              const storedTokenEmail = storedTokenClaims?.email || '';
              
              // Verify the stored token's email matches the current Microsoft user's email
              if (storedTokenEmail.toLowerCase() === currentMicrosoftEmail.toLowerCase()) {
                // Use stored token and user (from previous Microsoft login that exchanged for backend token)
                const user = JSON.parse(storedUser);
                const now = Date.now().toString();
                sessionStorage.setItem('lastActivity', now);
                localStorage.setItem('lastActivity', now);
                setAuthState({
                  isAuthenticated: true,
                  isLoading: false,
                  user: user
                });
                return;
              } else {
                // Email mismatch - clear stored data and fetch fresh token
                console.log('🔐 Email mismatch detected. Stored:', storedTokenEmail, 'Current Microsoft:', currentMicrosoftEmail);
                sessionStorage.removeItem('authToken');
                localStorage.removeItem('authToken');
                sessionStorage.removeItem('manualAuthUser');
                localStorage.removeItem('manualAuthUser');
              }
            }
          }
          
          // If no valid stored token or email mismatch, try to exchange Microsoft auth for backend token
          try {
            const idToken = await MicrosoftAuthService.getIdToken();
            const response = await ApiService.microsoftLogin(idToken);
            
            if (response.success && response.token) {
              // Verify the token
              const isTokenValid = JWTUtils.isTokenStructurallyValid(response.token);
              if (isTokenValid) {
                // Extract user info from JWT token
                const flatClaims = JWTUtils.getFlatClaims(response.token);
                if (flatClaims && flatClaims.email) {
                  const user = userFromClaims(flatClaims);
                  
                  // Store token and user
                  sessionStorage.setItem('authToken', response.token);
                  localStorage.setItem('authToken', response.token);
                  sessionStorage.setItem('manualAuthUser', JSON.stringify(user));
                  localStorage.setItem('manualAuthUser', JSON.stringify(user));
                  
                  const now = Date.now().toString();
                  sessionStorage.setItem('lastActivity', now);
                  localStorage.setItem('lastActivity', now);
                  setAuthState({
                    isAuthenticated: true,
                    isLoading: false,
                    user: user
                  });
                  return;
                }
              }
            }
          } catch (apiError) {
            // If backend token exchange fails, fall back to Microsoft-only auth (APIs won't work)
            console.warn('Backend token exchange failed, using Microsoft-only auth:', apiError);
          }
          
          // Fallback: Use Microsoft user info without backend token (APIs won't work)
          const user: User = {
            id: microsoftUser.id,
            name: microsoftUser.displayName,
            email: microsoftUser.mail || microsoftUser.userPrincipalName,
            title: 'Microsoft User',
            role: 'User',
            view: true,
            edit: false,
            settings: false,
            authMethod: 'microsoft'
          };
          const now = Date.now().toString();
          sessionStorage.setItem('lastActivity', now);
          localStorage.setItem('lastActivity', now);
          setAuthState({
            isAuthenticated: true,
            isLoading: false,
            user: user
          });
        } catch (error) {
          // If we can't get the user profile, treat as not authenticated
          setAuthState({
            isAuthenticated: false,
            isLoading: false,
            user: null
          });
        }
      } else {
        setAuthState(prevState => {
          // Only update if the state actually changed
          if (prevState.isAuthenticated !== false || prevState.isLoading !== false) {
            return {
              isAuthenticated: false,
              isLoading: false,
              user: null
            };
          }
          return prevState;
        });
      }
    } catch (error) {
      setAuthState(prevState => {
        // Only update if the state actually changed
        if (prevState.isAuthenticated !== false || prevState.isLoading !== false) {
          return {
            isAuthenticated: false,
            isLoading: false,
            user: null
          };
        }
        return prevState;
      });
    }
  }, [location.pathname, isPublicRoute]);

  // Debounce ref for updateLastActivity to prevent excessive updates from mousemove
  const updateLastActivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const DEBOUNCE_DELAY = 5000; // Only update lastActivity every 5 seconds max

  // Update last activity timestamp
  const updateLastActivity = useCallback(() => {
    if (authState.isAuthenticated) {
      // Clear existing debounce timeout
      if (updateLastActivityTimeoutRef.current) {
        clearTimeout(updateLastActivityTimeoutRef.current);
      }
      
      // Set new debounced update
      updateLastActivityTimeoutRef.current = setTimeout(() => {
        sessionStorage.setItem('lastActivity', Date.now().toString());
        localStorage.setItem('lastActivity', Date.now().toString());
        
        // Clear existing timer and reset it
        if (inactivityTimerRef.current) {
          clearTimeout(inactivityTimerRef.current);
        }
        updateLastActivityTimeoutRef.current = null;
      }, DEBOUNCE_DELAY);
    }
  }, [authState.isAuthenticated]);

  // Activity event handlers
  useEffect(() => {
    // Skip session timeout checks for public routes
    if (isPublicRoute(location.pathname)) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    if (!authState.isAuthenticated) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    // Initialize last activity on mount
    updateLastActivity();

    // List of events that indicate user activity
    // Note: mousemove is excluded to prevent constant timer resets from minor mouse movements
    // Only track intentional user actions
    const activityEvents = [
      'mousedown',
      'keypress',
      'scroll',
      'touchstart',
      'click',
      'keydown',
      'wheel'
    ];

    // Add event listeners
    activityEvents.forEach(event => {
      window.addEventListener(event, updateLastActivity, true);
    });

    // Check inactivity periodically
    const checkInterval = setInterval(() => {
      if (authState.isAuthenticated && isSessionTimedOut()) {
        redirectToLoginAfterTimeout();
      }
    }, 1000); // Check every second

    // Cleanup
    return () => {
      activityEvents.forEach(event => {
        window.removeEventListener(event, updateLastActivity, true);
      });
      clearInterval(checkInterval);
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
      if (updateLastActivityTimeoutRef.current) {
        clearTimeout(updateLastActivityTimeoutRef.current);
        updateLastActivityTimeoutRef.current = null;
      }
    };
  }, [authState.isAuthenticated, updateLastActivity, logout, location.pathname, isPublicRoute, INACTIVITY_TIMEOUT]);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  // Note: We do NOT clear localStorage on pagehide/pageunload because:
  // 1. sessionStorage already clears automatically when tab closes
  // 2. localStorage should persist across page navigations and reloads
  // 3. Token should only be cleared on explicit logout or session timeout
  // This allows forms opened in new tabs to access the token even after page reloads

  const login = async () => {
    try {
      // Step 1: Authenticate with Microsoft
      const authResult = await MicrosoftAuthService.signIn();

      // Step 2: Get Microsoft user profile using the token from sign-in result
      // This avoids calling getAccessToken() again which could fail with interaction_required
      const microsoftUser = await MicrosoftAuthService.getUserProfile(authResult.accessToken);

      // Step 3: Exchange the Microsoft ID token for a backend JWT token. The
      // backend verifies it and picks the email itself (sign-in alias first,
      // then mailbox address), so no email is chosen or sent from here.
      try {
        const response = await ApiService.microsoftLogin(authResult.idToken);
        
        if (!response.success || !response.token) {
          throw new Error(response.message || response.error || 'Failed to get backend token');
        }
        
        // Step 4: Sanity-check the token from the backend
        const isTokenValid = JWTUtils.isTokenStructurallyValid(response.token);
        if (!isTokenValid) {
          console.error('🔐 Token invalid or expired - unexpected response from backend');
          throw new Error('Invalid token received from backend');
        }
        
        // Step 5: Extract user info from JWT token (same as manual login)
        const flatClaims = JWTUtils.getFlatClaims(response.token);
        if (!flatClaims || !flatClaims.email) {
          throw new Error('Invalid token structure');
        }
        
        // Backend token is the source of truth for email and role flags — it
        // may have resolved a sign-in alias to the account's primary address.
        const user = userFromClaims(flatClaims);
        
        // Step 6: Store authentication data (same as manual login)
        sessionStorage.setItem('authToken', response.token);
        localStorage.setItem('authToken', response.token);
        sessionStorage.setItem('manualAuthUser', JSON.stringify(user));
        localStorage.setItem('manualAuthUser', JSON.stringify(user));
        sessionStorage.setItem('lastActivity', Date.now().toString());
        localStorage.setItem('lastActivity', Date.now().toString());
        
        // Step 7: Update auth state
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          user: user
        });
        
      } catch (apiError: any) {
        // If backend token exchange fails, still allow Microsoft auth but APIs won't work
        console.error('❌ Backend token exchange failed:', apiError);
        // Fallback: Use Microsoft user info without backend token (APIs won't work)
        const user: User = {
          id: microsoftUser.id,
          name: microsoftUser.displayName,
          email: microsoftUser.mail || microsoftUser.userPrincipalName,
          title: 'Microsoft User',
          role: 'User',
          view: true,
          edit: false,
          settings: false,
          authMethod: 'microsoft'
        };
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          user: user
        });
        // Re-throw the error so user knows APIs won't work
        throw new Error(`Microsoft authentication succeeded but backend token exchange failed: ${apiError.message || 'Please contact administrator'}`);
      }
    } catch (error) {
      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`Microsoft 365 login failed: ${error.message}`);
      } else {
        throw new Error('Microsoft 365 login failed with an unknown error');
      }
    }
  };

  return (
    <AuthContext.Provider value={{ authState, login, logout, initAuth }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
