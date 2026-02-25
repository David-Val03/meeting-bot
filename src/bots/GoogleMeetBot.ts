/* eslint-disable quotes */
import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import {
  handleUnsupportedMeetingError,
  handleWaitingAtLobbyError,
  MeetBotBase,
} from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import {
  GOOGLE_LOBBY_MODE_HOST_TEXT,
  GOOGLE_REQUEST_DENIED,
  GOOGLE_REQUEST_TIMEOUT,
} from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';

export class GoogleMeetBot extends MeetBotBase {
  private _logger: Logger;
  private _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
    this._correlationId = correlationId;
  }

  async join({
    url,
    name,
    bearerToken,
    teamId,
    timezone,
    userId,
    eventId,
    botId,
    uploader,
    audioOnly,
  }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', {
        uploadResult,
        userId,
        teamId,
      });
      return uploadResult;
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({
        url,
        name,
        bearerToken,
        teamId,
        timezone,
        userId,
        eventId,
        botId,
        uploader,
        pushState,
        audioOnly,
      });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
      }

      await patchBotStatus(
        {
          botId,
          eventId,
          provider: 'google',
          status: _state,
          token: bearerToken,
        },
        this._logger,
      );
    } catch (error) {
      this._logger.error('Error in GoogleMeetBot.join:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!_state.includes('finished')) _state.push('failed');

      await patchBotStatus(
        {
          botId,
          eventId,
          provider: 'google',
          status: _state,
          token: bearerToken,
        },
        this._logger,
      );

      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError(
          { token: bearerToken, botId, eventId, provider: 'google', error },
          this._logger,
        );
      }

      if (error instanceof UnsupportedMeetingError) {
        await handleUnsupportedMeetingError(
          { token: bearerToken, botId, eventId, provider: 'google', error },
          this._logger,
        );
      }

      throw error;
    }
  }

  private async joinMeeting({
    url,
    name,
    teamId,
    userId,
    eventId,
    botId,
    pushState,
    uploader,
  }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId, 'google');

    this._logger.info('Navigating to Google Meet URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    const dismissDeviceCheck = async () => {
      try {
        this._logger.info(
          'Clicking Continue without microphone and camera button...',
        );
        await retryActionWithWait(
          'Clicking the "Continue without microphone and camera" button',
          async () => {
            await this.page
              .getByRole('button', {
                name: 'Continue without microphone and camera',
              })
              .waitFor({ timeout: 30000 });
            await this.page
              .getByRole('button', {
                name: 'Continue without microphone and camera',
              })
              .click();
          },
          this._logger,
          1,
          15000,
        );
      } catch (dismissError) {
        this._logger.info(
          'Continue without microphone and camera button is probably missing!...',
        );
      }
    };

    await dismissDeviceCheck();

    const verifyItIsOnGoogleMeetPage = async (): Promise<
      'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null
    > => {
      try {
        const detectSignInPage = async () => {
          let result = false;
          const url = await this.page.url();
          if (url.startsWith('https://accounts.google.com/')) {
            this._logger.info('Google Meet bot is on the sign in page...', {
              userId,
              teamId,
            });
            result = true;
          }
          const signInPage = await this.page.locator('h1', {
            hasText: 'Sign in',
          });
          if (
            (await signInPage.count()) > 0 &&
            (await signInPage.isVisible())
          ) {
            this._logger.info(
              'Google Meet bot is on the page with "Sign in" heading...',
              { userId, teamId },
            );
            result = result && true;
          }
          return result;
        };
        const pageUrl = await this.page.url();
        if (!pageUrl.includes('meet.google.com')) {
          const signInPage = await detectSignInPage();
          return signInPage ? 'SIGN_IN_PAGE' : 'UNSUPPORTED_PAGE';
        }
        return 'GOOGLE_MEET_PAGE';
      } catch (e) {
        this._logger.error(
          'Error verifying if Google Meet bot is on the Google Meet page...',
          { error: e, message: e?.message },
        );
        return null;
      }
    };

    const googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();
    if (googleMeetPageStatus === 'SIGN_IN_PAGE') {
      this._logger.info('Exiting now as meeting requires sign in...', {
        googleMeetPageStatus,
        userId,
        teamId,
      });
      throw new UnsupportedMeetingError(
        'Meeting requires sign in',
        googleMeetPageStatus,
      );
    }

    if (googleMeetPageStatus === 'UNSUPPORTED_PAGE') {
      this._logger.info('Google Meet bot is on the unsupported page...', {
        googleMeetPageStatus,
        userId,
        teamId,
      });
    }

    this._logger.info('Waiting for the input field to be visible...');
    await retryActionWithWait(
      'Waiting for the input field',
      async () =>
        await this.page.waitForSelector(
          'input[type="text"][aria-label="Your name"]',
          { timeout: 10000 },
        ),
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(
          await this.page.screenshot({ type: 'png', fullPage: true }),
          'text-input-field-wait',
          userId,
          this._logger,
          botId,
        );
      },
    );

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    // Try to mute before joining
    await this.ensureMuted(
      'div[role="button"][aria-label="Turn off microphone"]',
      'pre-join',
    );

    this._logger.info('Filling the input field with the name...');
    await this.page.fill(
      'input[type="text"][aria-label="Your name"]',
      name ? name : 'ScreenApp Notetaker',
    );

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    await retryActionWithWait(
      'Clicking the "Ask to join" button',
      async () => {
        // Using the Order of most probable detection
        const possibleTexts = ['Ask to join', 'Join now', 'Join anyway'];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = await this.page
              .locator('button', {
                hasText: new RegExp(text.toLocaleLowerCase(), 'i'),
              })
              .first();
            if ((await button.count()) > 0) {
              await button.click({ timeout: 5000 });
              buttonClicked = true;
              this._logger.info(`Success clicked using "${text}" action...`);
              break;
            }
          } catch (err) {
            this._logger.warn(`Unable to click using "${text}" action...`);
          }
        }

        // Throws to initiate retries
        if (!buttonClicked) {
          throw new Error('Unable to complete the join action...');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(
          await this.page.screenshot({ type: 'png', fullPage: true }),
          'ask-to-join-button-click',
          userId,
          this._logger,
          botId,
        );
      },
    );

    // Do this to ensure meeting bot has joined the meeting

    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to admit the bot

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;

      const waitAtLobbyPromise = new Promise<boolean>((resolveWaiting) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveWaiting(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const detectLobbyModeHostWaitingText = async (): Promise<
              | 'WAITING_FOR_HOST_TO_ADMIT_BOT'
              | 'WAITING_REQUEST_TIMEOUT'
              | 'LOBBY_MODE_NOT_ACTIVE'
              | 'UNABLE_TO_DETECT_LOBBY_MODE'
            > => {
              try {
                const lobbyModeHostWaitingText = await this.page.getByText(
                  GOOGLE_LOBBY_MODE_HOST_TEXT,
                );
                if (
                  (await lobbyModeHostWaitingText.count()) > 0 &&
                  (await lobbyModeHostWaitingText.isVisible())
                ) {
                  return 'WAITING_FOR_HOST_TO_ADMIT_BOT';
                }

                const lobbyModeRequestTimeoutText = await this.page.getByText(
                  GOOGLE_REQUEST_TIMEOUT,
                );
                if (
                  (await lobbyModeRequestTimeoutText.count()) > 0 &&
                  (await lobbyModeRequestTimeoutText.isVisible())
                ) {
                  return 'WAITING_REQUEST_TIMEOUT';
                }

                return 'LOBBY_MODE_NOT_ACTIVE';
              } catch (e) {
                this._logger.error(
                  'Error detecting lobby mode host waiting text...',
                  { error: e, message: e?.message },
                );
                return 'UNABLE_TO_DETECT_LOBBY_MODE';
              }
            };

            let peopleElement;
            let callButtonElement;
            let botWasDeniedAccess = false;

            try {
              peopleElement = await this.page.waitForSelector(
                'button[aria-label="People"]',
                { timeout: 5000 },
              );
            } catch (e) {
              this._logger.error('wait error', { error: e });
              //do nothing
            }

            try {
              callButtonElement = await this.page.waitForSelector(
                'button[aria-label="Leave call"]',
                { timeout: 5000 },
              );
            } catch (e) {
              this._logger.error('wait error', { error: e });
              //do nothing
            }

            if (peopleElement || callButtonElement) {
              // Here check the "lobby mode" that waits for the Host to join the meeting or for the Host to admit the bot
              const lobbyModeHostWaitingText =
                await detectLobbyModeHostWaitingText();
              if (
                lobbyModeHostWaitingText === 'WAITING_FOR_HOST_TO_ADMIT_BOT'
              ) {
                this._logger.info(
                  'Lobbdy Mode: Google Meet Bot is waiting for the host to admit it...',
                  { userId, teamId },
                );
              } else if (
                lobbyModeHostWaitingText === 'WAITING_REQUEST_TIMEOUT'
              ) {
                this._logger.info(
                  'Lobby Mode: Google Meet Bot join request timed out...',
                  { userId, teamId },
                );
                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveWaiting(false);
                return;
              } else {
                // Additional check: Verify we can actually see participants (not just UI buttons)
                // The "Leave call" button can exist even in lobby waiting state
                try {
                  const participantCountDetected = await this.page.evaluate(
                    () => {
                      try {
                        // Look for People button with participant count
                        const peopleButton = document.querySelector(
                          'button[aria-label^="People"]',
                        );
                        if (peopleButton) {
                          const ariaLabel =
                            peopleButton.getAttribute('aria-label');
                          // Check if we can see participant count (e.g., "People - 2 joined")
                          const match = ariaLabel?.match(/People.*?(\d+)/);
                          if (match && parseInt(match[1]) >= 1) {
                            return true;
                          }
                        }

                        // Alternative: Check if participant count is visible in the DOM
                        const allButtons = Array.from(
                          document.querySelectorAll('button'),
                        );
                        for (const btn of allButtons) {
                          const label = btn.getAttribute('aria-label');
                          if (label && /People.*?\d+/.test(label)) {
                            return true;
                          }
                        }

                        // Fallback: Check for text that indicates we're in the call
                        const bodyText = document.body.innerText;
                        if (
                          bodyText.includes('You have joined the call') ||
                          bodyText.includes('other person in the call') ||
                          bodyText.includes('people in the call')
                        ) {
                          return true;
                        }

                        // Fallback: Check for Leave call button which indicates we're in a call
                        const leaveCallButton = document.querySelector(
                          'button[aria-label="Leave call"]',
                        );
                        if (leaveCallButton) {
                          // If we have Leave call button AND no lobby mode text, we're likely in the call
                          const hasLobbyText =
                            bodyText.includes('Asking to join') ||
                            bodyText.includes("You're the only one here");
                          if (!hasLobbyText) {
                            return true;
                          }
                        }

                        return false;
                      } catch (e) {
                        return false;
                      }
                    },
                  );

                  if (participantCountDetected) {
                    this._logger.info(
                      'Google Meet Bot is entering the meeting...',
                      { userId, teamId },
                    );
                    clearInterval(waitInterval);
                    clearTimeout(waitTimeout);
                    resolveWaiting(true);
                    return;
                  } else {
                    this._logger.info(
                      'People button found but participant count not visible yet - continuing to wait...',
                      { userId, teamId },
                    );
                    return;
                  }
                } catch (e) {
                  this._logger.error('Error checking participant visibility', {
                    error: e,
                  });
                  return;
                }
              }
            }

            try {
              const deniedText = await this.page.getByText(
                GOOGLE_REQUEST_DENIED,
              );
              if (
                (await deniedText.count()) > 0 &&
                (await deniedText.isVisible())
              ) {
                botWasDeniedAccess = true;
              }
            } catch (e) {
              //do nothing
            }
            if (botWasDeniedAccess) {
              this._logger.info(
                'Google Meet Bot is denied access to the meeting...',
                { userId, teamId },
              );
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(false);
            }
          } catch (e) {
            this._logger.error('wait error', { error: e });
            // Do nothing
          }
        }, 20000);
      });

      const waitingAtLobbySuccess = await waitAtLobbyPromise;
      if (!waitingAtLobbySuccess) {
        const bodyText = await this.page.evaluate(
          () => document.body.innerText,
        );

        const userDenied = (bodyText || '')?.includes(GOOGLE_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', {
          userDenied,
          waitingAtLobbySuccess,
          bodyText,
        });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError(
          'Google Meet bot could not enter the meeting...',
          bodyText ?? '',
          false,
          0,
        );
      }
    } catch (lobbyError) {
      this._logger.info('Closing the browser on error...', lobbyError);
      await this.page.context().browser()?.close();

      throw lobbyError;
    }

    pushState('joined');

    try {
      this._logger.info('Waiting for the "Got it" button...');
      await this.page.waitForSelector('button:has-text("Got it")', {
        timeout: 15000,
      });

      this._logger.info('Going to click all visible "Got it" buttons...');

      let gotItButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations

      while (true) {
        const visibleButtons = await this.page
          .locator('button:visible', {
            hasText: 'Got it',
          })
          .all();

        const currentButtonCount = visibleButtons.length;

        if (currentButtonCount === 0) {
          break;
        }

        // Check if button count hasn't changed (indicating we might be stuck)
        if (currentButtonCount === previousButtonCount) {
          consecutiveNoChangeCount++;
          if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
            this._logger.warn(
              `Button count hasn't changed for ${maxConsecutiveNoChange} iterations, stopping`,
            );
            break;
          }
        } else {
          consecutiveNoChangeCount = 0;
        }

        previousButtonCount = currentButtonCount;

        for (const btn of visibleButtons) {
          try {
            await btn.click({ timeout: 5000 });
            gotItButtonsClicked++;
            this._logger.info(
              `Clicked a "Got it" button #${gotItButtonsClicked}`,
            );

            await this.page.waitForTimeout(2000);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', {
              error: err,
            });
          }
        }

        await this.page.waitForTimeout(2000);
      }
    } catch (error) {
      // Log and ignore this error
      this._logger.info('"Got it" modals might be missing...', { error });
    }

    // Dismiss "Microphone not found" and "Camera not found" notifications if present
    try {
      this._logger.info(
        'Checking for device notifications (microphone/camera)...',
      );
      const hasDeviceNotification = await this.page.evaluate(() => {
        return (
          document.body.innerText.includes('Microphone not found') ||
          document.body.innerText.includes(
            'Make sure your microphone is plugged in',
          ) ||
          document.body.innerText.includes('Camera not found') ||
          document.body.innerText.includes(
            'Make sure your camera is plugged in',
          )
        );
      });

      if (hasDeviceNotification) {
        this._logger.info(
          'Found device notification (microphone/camera), attempting to dismiss...',
        );
        // Try to find and click all close buttons
        const closeButtonsCount = await this.page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const closeButtons = allButtons.filter((btn) => {
            const ariaLabel = btn.getAttribute('aria-label');
            const hasCloseIcon = btn.querySelector('svg') !== null;
            return (
              ariaLabel?.toLowerCase().includes('close') ||
              ariaLabel?.toLowerCase().includes('dismiss') ||
              (hasCloseIcon &&
                btn?.offsetParent !== null &&
                btn.innerText === '')
            );
          });

          let clickedCount = 0;
          closeButtons.forEach((btn) => {
            if (btn?.offsetParent !== null) {
              btn.click();
              clickedCount++;
            }
          });
          return clickedCount;
        });

        if (closeButtonsCount > 0) {
          this._logger.info(
            `Successfully dismissed ${closeButtonsCount} device notification(s)`,
          );
          await this.page.waitForTimeout(1000);
        } else {
          this._logger.warn(
            'Could not find close button for device notifications',
          );
        }
      }
    } catch (error) {
      this._logger.info('Error checking/dismissing device notifications...', {
        error,
      });
    }

    // Try to mute after joining
    await this.ensureMuted(
      'button[aria-label="Turn off microphone"]',
      'post-join',
    );

    // Turn on captions
    try {
      this._logger.info('Attempting to turn on captions...');

      // Debug: Log all buttons to find the right one
      const buttons = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map((b) => ({
          ariaLabel: b.getAttribute('aria-label'),
          text: b.innerText,
          visible: b.offsetParent !== null,
        }));
      });
      const potentialCaptionButtons = buttons.filter(
        (b) =>
          b.ariaLabel?.toLowerCase().includes('caption') ||
          b.ariaLabel?.toLowerCase().includes('cc') ||
          b.text?.toLowerCase().includes('caption'),
      );
      this._logger.info('Potential caption buttons found:', {
        potentialCaptionButtons,
      });

      const captionButton = this.page.locator(
        'button[aria-label="Turn on captions"]',
      );
      if ((await captionButton.count()) > 0) {
        await captionButton.click();
        this._logger.info('Clicked "Turn on captions" button');
      } else {
        this._logger.warn(
          '"Turn on captions" button not found matching exact selector',
        );

        // Try fallback click if we found a potential candidate in debug
        const fallback = this.page
          .locator(
            'button[aria-label*="Turn on captions"], button[aria-label*="captions"]',
          )
          .first();
        if ((await fallback.count()) > 0) {
          this._logger.info('Attempting to click fallback caption button...');
          await fallback.click();
        }
      }
    } catch (error) {
      this._logger.warn('Failed to turn on captions', { error });
    }

    // Recording the meeting page (Line 703)

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({
      teamId,
      eventId,
      userId,
      botId,
      uploader,
    });

    pushState('finished');

    pushState('finished');
  }

  private async recordMeetingPage({
    teamId,
    userId,
    eventId,
    botId,
    uploader,
  }: {
    teamId: string;
    userId: string;
    eventId?: string;
    botId?: string;
    uploader: IUploader;
  }): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    const inactivityLimit = config.inactivityLimit * 60 * 1000;

    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async (msg) => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch (err) {
        this._logger.info(
          'Playwright chrome logger: Failed to log browser messages...',
          err?.message,
        );
      }
    });

    await this.page.exposeFunction(
      'screenAppSendData',
      async (slightlySecretId: string, data: string) => {
        if (slightlySecretId !== this.slightlySecretId) return;

        const buffer = Buffer.from(data, 'base64');
        await uploader.saveDataToTempFile(buffer);
      },
    );

    await this.page.exposeFunction(
      'screenAppSendTranscript',
      async (transcriptData: any) => {
        // Validation ideally via secret, or trust page context since we control injection
        await uploader.saveTranscript(transcriptData);
      },
    );

    await this.page.exposeFunction(
      'screenAppMeetEnd',
      (slightlySecretId: string) => {
        if (slightlySecretId !== this.slightlySecretId) return;
        try {
          this._logger.info('Attempt to end meeting early...');
          waitingPromise.resolveEarly();
        } catch (error) {
          console.error('Could not process meeting end event', error);
        }
      },
    );

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({
        teamId,
        duration,
        inactivityLimit,
        userId,
        slightlySecretId,
        activateInactivityDetectionAfterMinutes,
        primaryMimeType,
        secondaryMimeType,
      }: {
        teamId: string;
        userId: string;
        duration: number;
        inactivityLimit: number;
        slightlySecretId: string;
        activateInactivityDetectionAfterMinutes: number;
        primaryMimeType: string;
        secondaryMimeType: string;
      }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityParticipantDetectionTimeout: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;
        let isOnValidGoogleMeetPageInterval: NodeJS.Timeout;

        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('[Bot] Recording started.');

          // Check for the availability of the mediaDevices API
          if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getDisplayMedia
          ) {
            console.error(
              'MediaDevices or getDisplayMedia not supported in this browser.',
            );
            return;
          }

          const stream: MediaStream = await (
            navigator.mediaDevices as any
          ).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;

          if (!hasAudioTracks) {
            console.warn(
              'No audio tracks available for silence detection. Will rely only on presence detection.',
            );
          }

          const recordingStream = stream;

          let options: MediaRecorderOptions = {};
          if (MediaRecorder.isTypeSupported(primaryMimeType)) {
            options = { mimeType: primaryMimeType };
          } else {
            console.warn(
              `Primary codec ${primaryMimeType} not supported, using fallback ${secondaryMimeType}`,
            );
            options = { mimeType: secondaryMimeType };
          }

          const mediaRecorder = new MediaRecorder(recordingStream, {
            ...options,
          });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          let dismissModalsInterval: NodeJS.Timeout;
          let lastDimissError: Error | null = null;

          const stopTheRecording = async () => {
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityParticipantDetectionTimeout) {
              clearTimeout(inactivityParticipantDetectionTimeout);
            }
            if (inactivitySilenceDetectionTimeout) {
              clearTimeout(inactivitySilenceDetectionTimeout);
            }

            if (loneTest) {
              clearTimeout(loneTest);
            }

            if (isOnValidGoogleMeetPageInterval) {
              clearInterval(isOnValidGoogleMeetPageInterval);
            }

            if (dismissModalsInterval) {
              clearInterval(dismissModalsInterval);
              if (lastDimissError && lastDimissError instanceof Error) {
                console.error('Error dismissing modals:', {
                  lastDimissError,
                  message: lastDimissError?.message,
                });
              }
            }

            // Flush last in-flight transcript utterance before closing
            if ((window as any).__transcriptFlush) {
              (window as any).__transcriptFlush();
            }
            // Clear transcript poll interval
            if ((window as any).__transcriptPollInterval) {
              clearInterval((window as any).__transcriptPollInterval);
            }
            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let detectionFailures = 0;
          let loneTestDetectionActive = true;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures

          function detectLoneParticipantResilient(): void {
            const re = /^[0-9]+$/;

            function getContributorsCount(): number | undefined {
              function findPeopleButton() {
                try {
                  // 1. Try to locate using attribute "starts with"
                  let btn: Element | null | undefined = document.querySelector(
                    'button[aria-label^="People -"]',
                  );
                  if (btn) return btn;

                  // 2. Try to locate using attribute "contains"
                  btn = document.querySelector('button[aria-label*="People"]');
                  if (btn) return btn;

                  // 3. Try via aria-labelledby pointing to element with "People" text
                  const allBtns = Array.from(
                    document.querySelectorAll('button[aria-labelledby]'),
                  );
                  btn = allBtns.find((b) => {
                    const labelledBy = b.getAttribute('aria-labelledby');
                    if (labelledBy) {
                      const labelElement = document.getElementById(labelledBy);
                      if (
                        labelElement &&
                        labelElement.textContent?.trim() === 'People'
                      ) {
                        return true;
                      }
                    }
                    return false;
                  });
                  if (btn) return btn;

                  // 4. Try via regex on aria-label (for more complex patterns)
                  const allBtnsWithLabel = Array.from(
                    document.querySelectorAll('button[aria-label]'),
                  );
                  btn = allBtnsWithLabel.find((b) => {
                    const label = b.getAttribute('aria-label');
                    return label && /^People - \d+ joined$/.test(label);
                  });
                  if (btn) return btn;

                  // 5. Fallback: Look for button with a child icon containing "people"
                  btn = allBtnsWithLabel.find((b) =>
                    Array.from(b.querySelectorAll('i')).some(
                      (i) => i.textContent && i.textContent.trim() === 'people',
                    ),
                  );
                  if (btn) return btn;

                  // 6. Not found
                  return null;
                } catch (error) {
                  console.log('Error finding people button:', error);
                  return null;
                }
              }

              // Find participant count badge near People button (doesn't require opening panel)
              try {
                const peopleBtn = findPeopleButton();
                // console.log('[Detection] People button found:', !!peopleBtn);

                if (peopleBtn) {
                  // Search INSIDE the button (descendants) and nearby (parent container)
                  const searchRoots = [
                    peopleBtn, // Search inside button itself
                    peopleBtn.parentElement,
                    peopleBtn.parentElement?.parentElement,
                  ].filter(Boolean);

                  // console.log('[Detection] Searching', searchRoots.length, 'containers');

                  for (const searchRoot of searchRoots) {
                    if (!searchRoot) continue;

                    // Method 1: Look for data-avatar-count attribute (most reliable)
                    const avatarSpan = searchRoot.querySelector(
                      '[data-avatar-count]',
                    );
                    if (avatarSpan) {
                      const countAttr =
                        avatarSpan.getAttribute('data-avatar-count');
                      // console.log('[Detection] Method 1 SUCCESS - data-avatar-count:', countAttr);
                      const count = Number(countAttr);
                      if (!isNaN(count) && count > 0) {
                        return count;
                      }
                    }

                    // Method 2: Fallback - Look for number in badge div
                    const badgeDiv = searchRoot.querySelector(
                      'div.egzc7c',
                    ) as HTMLElement;
                    if (badgeDiv) {
                      const text = (
                        (badgeDiv.innerText || badgeDiv.textContent) ??
                        ''
                      ).trim();
                      if (
                        text.length > 0 &&
                        text.length <= 3 &&
                        re.test(text)
                      ) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 2 SUCCESS - Badge text:', text);
                          return count;
                        }
                      }
                    }
                  }

                  // Method 3: Last resort - search for short numbers in People button area
                  const mainSearchRoot =
                    peopleBtn.parentElement?.parentElement || peopleBtn;
                  const allDivs = Array.from(
                    mainSearchRoot.querySelectorAll('div'),
                  );
                  for (const div of allDivs) {
                    const text = (
                      (div as HTMLElement).innerText ||
                      div.textContent ||
                      ''
                    ).trim();
                    if (text.length > 0 && text.length <= 3 && re.test(text)) {
                      const isVisible =
                        (div as HTMLElement).offsetParent !== null;
                      if (isVisible) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 3 SUCCESS - Found number:', count);
                          return count;
                        }
                      }
                    }
                  }
                  // console.log('[Detection] All methods failed to find count');
                } else {
                  // console.log('[Detection] People button NOT found');
                }
              } catch (error) {
                console.log('Error finding participant badge:', error);
              }

              return undefined;
            }

            function retryWithBackoff(): void {
              loneTest = setTimeout(function check() {
                if (!loneTestDetectionActive) {
                  if (loneTest) {
                    clearTimeout(loneTest);
                  }
                  return;
                }
                let contributors: number | undefined;
                try {
                  contributors = getContributorsCount();

                  // Log participant count once per minute

                  if (typeof contributors === 'undefined') {
                    detectionFailures++;
                    console.warn(
                      'Meet participant detection failed, retrying. Failure count:',
                      detectionFailures,
                    );
                    if (detectionFailures >= maxDetectionFailures) {
                      loneTestDetectionActive = false;
                    }
                    retryWithBackoff();
                    return;
                  }
                  detectionFailures = 0;
                  if (contributors < 2) {
                    console.log('Bot is alone, ending meeting.');
                    loneTestDetectionActive = false;
                    stopTheRecording();
                    return;
                  }
                } catch (err) {
                  detectionFailures++;
                  console.error('Detection error:', err, detectionFailures);
                  retryWithBackoff();
                  return;
                }
                retryWithBackoff();
              }, 5000);
            }

            retryWithBackoff();
          }

          const detectIncrediblySilentMeeting = () => {
            // Only run silence detection if we have audio tracks
            if (!hasAudioTracks) {
              console.warn(
                'Skipping silence detection - no audio tracks available. This may be due to browser permissions or Google Meet audio sharing settings.',
              );
              console.warn(
                'Meeting will rely on presence detection and max duration timeout.',
              );
              return;
            }

            try {
              const audioContext = new AudioContext();
              const mediaSource = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();

              /* Use a value suitable for the given use case of silence detection
                 |
                 |____ Relatively smaller FFT size for faster processing and less sampling
              */
              analyser.fftSize = 256;

              mediaSource.connect(analyser);

              const dataArray = new Uint8Array(analyser.frequencyBinCount);

              // Sliding silence period
              let silenceDuration = 0;
              let totalChecks = 0;
              let audioActivitySum = 0;

              // Audio gain/volume
              const silenceThreshold = 10;

              let monitor = true;

              const monitorSilence = () => {
                try {
                  analyser.getByteFrequencyData(dataArray);

                  const audioActivity =
                    dataArray.reduce((a, b) => a + b) / dataArray.length;
                  audioActivitySum += audioActivity;
                  totalChecks++;

                  if (audioActivity < silenceThreshold) {
                    silenceDuration += 100; // Check every 100ms
                    if (silenceDuration >= inactivityLimit) {
                      console.warn(
                        'Detected silence in Google Meet and ending the recording on team:',
                        userId,
                        teamId,
                      );
                      console.log(
                        'Silence detection stats - Avg audio activity:',
                        (audioActivitySum / totalChecks).toFixed(2),
                        'Checks performed:',
                        totalChecks,
                      );
                      monitor = false;
                      stopTheRecording();
                    }
                  } else {
                    silenceDuration = 0;
                  }

                  if (monitor) {
                    // Recursively queue the next check
                    setTimeout(monitorSilence, 100);
                  }
                } catch (error) {
                  console.error('Error in silence monitoring:', error);
                  console.warn(
                    'Silence detection failed - will rely on presence detection and max duration timeout.',
                  );
                  // Stop monitoring on error
                  monitor = false;
                }
              };

              // Go silence monitor
              monitorSilence();
            } catch (error) {
              console.error('Failed to initialize silence detection:', error);
              console.warn(
                'Silence detection initialization failed - will rely on presence detection and max duration timeout.',
              );
            }
          };

          /**
           * Perpetual checks for inactivity detection
           */
          inactivityParticipantDetectionTimeout = setTimeout(
            () => {
              detectLoneParticipantResilient();
            },
            activateInactivityDetectionAfterMinutes * 60 * 1000,
          );

          inactivitySilenceDetectionTimeout = setTimeout(
            () => {
              detectIncrediblySilentMeeting();
            },
            activateInactivityDetectionAfterMinutes * 60 * 1000,
          );

          const detectModalsAndDismiss = () => {
            let dismissModalErrorCount = 0;
            const maxDismissModalErrorCount = 10;
            dismissModalsInterval = setInterval(() => {
              try {
                const buttons = document.querySelectorAll('button');
                const dismissButtons = Array.from(buttons).filter(
                  (button) =>
                    button?.offsetParent !== null &&
                    button?.innerText?.includes('Got it'),
                );
                if (dismissButtons.length > 0) {
                  dismissButtons[0].click();
                }

                // Dismiss "Microphone not found" and "Camera not found" notifications
                const bodyText = document.body.innerText;
                if (
                  bodyText.includes('Microphone not found') ||
                  bodyText.includes(
                    'Make sure your microphone is plugged in',
                  ) ||
                  bodyText.includes('Camera not found') ||
                  bodyText.includes('Make sure your camera is plugged in')
                ) {
                  // Look for close button (X) near the notification
                  const allButtons = Array.from(
                    document.querySelectorAll('button'),
                  );
                  const closeButtons = allButtons.filter((btn) => {
                    const ariaLabel = btn.getAttribute('aria-label');
                    const hasCloseIcon = btn.querySelector('svg') !== null;
                    // Look for close/dismiss buttons
                    return (
                      ariaLabel?.toLowerCase().includes('close') ||
                      ariaLabel?.toLowerCase().includes('dismiss') ||
                      (hasCloseIcon &&
                        btn?.offsetParent !== null &&
                        btn.innerText === '')
                    );
                  });

                  // Click all visible close buttons to dismiss all notifications
                  closeButtons.forEach((btn) => {
                    if (btn?.offsetParent !== null) btn.click();
                  });
                }

                // Dismiss the Google Meet "You are now presenting" bar.
                // This appears because getDisplayMedia(preferCurrentTab:true) tells Chrome to
                // signal tab capture to Google Meet, making the bot appear as a presenter.
                // We immediately click "Stop presenting" to cancel the presentation.
                const stopPresentingBtn = Array.from(
                  document.querySelectorAll('button'),
                ).find(
                  (btn) =>
                    btn?.offsetParent !== null &&
                    (btn
                      .getAttribute('aria-label')
                      ?.toLowerCase()
                      .includes('stop presenting') ||
                      btn
                        .getAttribute('aria-label')
                        ?.toLowerCase()
                        .includes('stop sharing') ||
                      btn.innerText
                        ?.toLowerCase()
                        .includes('stop presenting') ||
                      btn.innerText?.toLowerCase().includes('stop sharing')),
                );
                if (stopPresentingBtn) {
                  console.log(
                    '[BotRecorder] Dismissing "You are presenting" bar — stopping accidental screen share...',
                  );
                  (stopPresentingBtn as HTMLElement).click();
                }
              } catch (error) {
                lastDimissError = error;
                dismissModalErrorCount += 1;
                if (dismissModalErrorCount > maxDismissModalErrorCount) {
                  console.error(
                    `Failed to detect and dismiss "Got it" modals ${maxDismissModalErrorCount} times, will stop trying...`,
                  );
                  clearInterval(dismissModalsInterval);
                }
              }
            }, 2000);
          };

          const detectMeetingIsOnAValidPage = () => {
            // Simple check to verify we're still on a supported Google Meet page
            const isOnValidGoogleMeetPage = () => {
              try {
                // Check if we're still on a Google Meet URL
                const currentUrl = window.location.href;
                if (!currentUrl.includes('meet.google.com')) {
                  console.warn(
                    'No longer on Google Meet page - URL changed to:',
                    currentUrl,
                  );
                  return false;
                }

                const currentBodyText = document.body.innerText;
                if (
                  currentBodyText.includes(
                    "You've been removed from the meeting",
                  )
                ) {
                  console.warn(
                    'Bot was removed from the meeting - ending recording on team:',
                    userId,
                    teamId,
                  );
                  return false;
                }

                if (
                  currentBodyText.includes(
                    'No one responded to your request to join the call',
                  )
                ) {
                  console.warn(
                    'Bot was not admitted to the meeting - ending recording on team:',
                    userId,
                    teamId,
                  );
                  return false;
                }

                // Check for basic Google Meet UI elements.
                // NOTE: During screen share Google hides the bottom toolbar briefly,
                // so we check multiple selectors to avoid a false-positive "left meeting".
                const hasMeetElements =
                  document.querySelector('button[aria-label="People"]') !==
                    null ||
                  document.querySelector('button[aria-label="Leave call"]') !==
                    null ||
                  // Shown during presentation mode when someone shares screen
                  document.querySelector(
                    'button[aria-label="Stop presenting"]',
                  ) !== null ||
                  document.querySelector(
                    'button[aria-label="End presentation"]',
                  ) !== null ||
                  // Persistent toolbar icons visible in all Meet states
                  document.querySelector(
                    'button[aria-label="Chat with everyone"]',
                  ) !== null ||
                  document.querySelector('[data-meeting-ended="false"]') !==
                    null;

                if (!hasMeetElements) {
                  console.warn(
                    'Google Meet UI elements not found - page may have changed state',
                  );
                  return false;
                }

                return true;
              } catch (error) {
                console.error('Error checking page validity:', error);
                return false;
              }
            };

            // check if we're still on a valid Google Meet page
            isOnValidGoogleMeetPageInterval = setInterval(() => {
              if (!isOnValidGoogleMeetPage()) {
                console.log(
                  'Google Meet page state changed - ending recording on team:',
                  userId,
                  teamId,
                );
                clearInterval(isOnValidGoogleMeetPageInterval);
                stopTheRecording();
              }
            }, 10000);
          };

          detectModalsAndDismiss();

          detectMeetingIsOnAValidPage();

          // Transcript Scraping Logic
          // Uses multiple strategies since Google Meet class names change frequently.
          const startTranscriptScraping = () => {
            console.log('Starting transcript scraping (multi-strategy)...');

            /**
             * Core function: try every known strategy to extract the current
             * caption text + speaker name visible on screen.
             */
            const extractCaption = (): {
              speaker: string;
              text: string;
            } | null => {
              // ── Strategy 1: Google Meet captions container (confirmed from real DOM) ──
              // The outer container is div[aria-label="Captions"] — this ARIA attribute
              // is stable. Inside each caption entry (.nMcdL > .bj4p3b):
              //   speaker:  span.NWpY1d  (or div.KcIKyf span)
              //   text:     div.ygicle   (or div.VbkSUe as a fallback class)
              const captionsRoot = document.querySelector(
                'div[aria-label="Captions"]',
              );
              if (captionsRoot) {
                // Each caption entry is a .nMcdL block inside the root
                const entries =
                  captionsRoot.querySelectorAll('.nMcdL, .bj4p3b');
                // Iterate backwards to read the newest, actively growing caption block
                for (const entry of Array.from(entries).reverse()) {
                  const textEl = entry.querySelector(
                    'div.ygicle, div.VbkSUe, div.iTTPOb',
                  ) as HTMLElement | null;
                  const speakerEl = entry.querySelector(
                    'span.NWpY1d, div.KcIKyf span, div.adE6rb span',
                  ) as HTMLElement | null;
                  const text = textEl?.innerText?.trim() ?? '';
                  const speaker = speakerEl?.innerText?.trim() ?? '';
                  if (text) {
                    return { speaker, text };
                  }
                }
              }

              // ── Strategy 2: aria-live / role="status" regions ──
              // NOTE: only fire when the caption container (S1) has text; aria-live
              // regions in Google Meet also emit UI *notifications* ("has left the
              // meeting", connectivity warnings, etc.) which must be filtered out.
              const UI_NOTIFICATION_PATTERNS = [
                'has left the meeting',
                'has joined the meeting',
                'is in the waiting room',
                'no one else is in this meeting',
                'your internet connection',
                'internet connection is unstable',
                'is having connection issues',
                'is now presenting',
                'stopped presenting',
                'jump to bottom',
                'you are muted',
                'unmute yourself',
                'meeting code',
                'get help here',
                'go to the more options',
                'has been admitted',
                "you've been removed",
                'you have been removed',
                'seconds left',
                'returning to home screen',
              ];
              const ariaRegions = document.querySelectorAll(
                '[aria-live="polite"], [aria-live="assertive"], [role="status"]',
              );
              for (const region of Array.from(ariaRegions)) {
                const text = (region as HTMLElement).innerText?.trim() ?? '';
                if (!text || text.length >= 500 || text.length <= 2) continue;
                const tLower = text.toLowerCase();
                const isNotification = UI_NOTIFICATION_PATTERNS.some((p) =>
                  tLower.includes(p),
                );
                if (!isNotification) {
                  return { speaker: '', text };
                }
              }

              // ── Strategy 3: position-based bottom 35% of viewport ──
              const vh = window.innerHeight;
              const captionZoneTop = vh * 0.65;
              const allDivs = Array.from(
                document.querySelectorAll('div, span'),
              );

              const candidateTexts: string[] = [];
              for (const el of allDivs) {
                const rect = el.getBoundingClientRect();
                if (
                  rect.top >= captionZoneTop &&
                  rect.bottom <= vh + 10 &&
                  rect.width > 100
                ) {
                  const elHtml = el as HTMLElement;
                  // Skip buttons and labelled controls (UI chrome)
                  if (
                    elHtml.tagName === 'BUTTON' ||
                    elHtml.getAttribute('role') === 'button' ||
                    elHtml.hasAttribute('aria-label')
                  )
                    continue;
                  const ownText = Array.from(el.childNodes)
                    .filter((n) => n.nodeType === Node.TEXT_NODE)
                    .map((n) => n.textContent?.trim())
                    .join(' ')
                    .trim();
                  // Require at least 20 chars — filters out meeting codes / nav labels
                  if (ownText && ownText.length >= 20 && ownText.length < 300) {
                    candidateTexts.push(ownText);
                  } else if (
                    elHtml.innerText &&
                    elHtml.children.length === 0 &&
                    elHtml.innerText.length >= 20 &&
                    elHtml.innerText.length < 300
                  ) {
                    candidateTexts.push(elHtml.innerText.trim());
                  }
                }
              }
              if (candidateTexts.length > 0) {
                return { speaker: '', text: candidateTexts.join(' ') };
              }
              return null;
            };

            // ── Transcript buffering: commit-on-block-reset ──────────────────────
            // Strategy: Google Meet keeps ONE growing caption block. Words are
            // appended live (~300ms apart). The block RESETS (clears & starts
            // fresh) when the speaker pauses or a sentence ends naturally.
            // We buffer the growing text and only commit when:
            //   1. The caption disappears (block cleared)
            //   2. The new text is shorter / diverges from the old text (reset)
            //   3. The utterance exceeds MAX_UTTERANCE_CHARS (very long speech)
            //   4. __transcriptFlush() is called before recording stops
            //
            // NO debounce — a debounce fires mid-utterance and generates
            // multiple duplicate entries for the same block.
            let pendingText = '';
            let pendingSpeaker = '';
            const MAX_UTTERANCE_CHARS = 400;

            const clean = (t: string) =>
              t.toLowerCase().replace(/[^a-z0-9]/g, '');

            const sendCommitted = (speaker: string, text: string) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              const transcriptData = {
                type: 'transcript',
                timestamp: new Date().toISOString(),
                speaker: speaker || 'Unknown Speaker',
                text: trimmed,
              };
              console.log(
                `[Transcript] ${transcriptData.speaker}: ${trimmed.slice(0, 120)}`,
              );
              if ((window as any).screenAppSendTranscript) {
                (window as any).screenAppSendTranscript(transcriptData);
              }
            };

            const processCaption = () => {
              try {
                const result = extractCaption();

                // Case 1: Caption disappeared → commit pending
                if (!result || !result.text) {
                  if (pendingText) sendCommitted(pendingSpeaker, pendingText);
                  pendingText = '';
                  pendingSpeaker = '';
                  return;
                }

                const { text, speaker } = result;
                const tLower = text.toLowerCase();

                // Noise filter: skip Google Meet policy/abuse/removal notices
                if (
                  tLower.includes('abuse is reported on a call') ||
                  tLower.includes('google for verification') ||
                  tLower.includes("you've been removed") ||
                  tLower.includes('you have been removed') ||
                  tLower.includes('seconds left') ||
                  tLower.includes('returning to home screen')
                ) {
                  return;
                }

                if (text === pendingText) return; // no change

                // Continuation check (normalized — ignores punctuation/case):
                //   - new text must be at least as long as the old text, AND
                //   - its normalized form must begin with the old text's prefix
                // If either fails → the block was reset → commit old utterance.
                const normOld = clean(pendingText);
                const normNew = clean(text);
                const prefixLen = Math.min(normOld.length, 30);
                const isContinuation =
                  pendingText.length === 0 ||
                  (normNew.length >= normOld.length &&
                    normNew.startsWith(normOld.substring(0, prefixLen)));

                if (!isContinuation) {
                  // Block reset → commit the completed utterance
                  if (pendingText) sendCommitted(pendingSpeaker, pendingText);
                }

                pendingText = text;
                pendingSpeaker = speaker;

                // Safety flush for very long continuous speech
                if (pendingText.length > MAX_UTTERANCE_CHARS) {
                  sendCommitted(pendingSpeaker, pendingText);
                  pendingText = '';
                  pendingSpeaker = '';
                }
              } catch (e) {
                // Swallow — don't let transcript errors kill the recording
              }
            };

            // Flush the last in-flight utterance (called before recording stops)
            (window as any).__transcriptFlush = () => {
              if (pendingText) {
                sendCommitted(pendingSpeaker, pendingText);
                pendingText = '';
                pendingSpeaker = '';
              }
            };

            // MutationObserver — fires on DOM changes (immediate)
            const observer = new MutationObserver(() => processCaption());
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });

            // setInterval fallback — polls every 2 s in case the observer misses rapid updates
            const pollInterval = setInterval(processCaption, 2000);

            console.log(
              'Transcript observing started (MutationObserver + 2s poll)',
            );

            // Store cleanup ref on window so stopTheRecording can clear the interval
            (window as any).__transcriptPollInterval = pollInterval;
          };

          // Call the function to start scraped logic
          startTranscriptScraping();

          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
      {
        teamId,
        duration,
        inactivityLimit,
        userId,
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes:
          config.activateInactivityDetectionAfter,
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType,
      },
    );

    this._logger.info(
      'Waiting for recording duration',
      config.maxRecordingDuration,
      'minutes...',
    );
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(
      processingTime + duration,
    );

    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;
  }

  private async ensureMuted(selector: string, location: string): Promise<void> {
    try {
      this._logger.info(`Attempting to mute at ${location}...`);
      const muteButton = this.page.locator(selector).first();

      if ((await muteButton.count()) > 0 && (await muteButton.isVisible())) {
        const isMuted = await muteButton.getAttribute('data-is-muted');
        if (isMuted === 'false') {
          await muteButton.click();
          this._logger.info(`Clicked mute button at ${location}`);
          // Optional: wait and verify
          await this.page.waitForTimeout(500);
        } else {
          this._logger.info(`Microphone already muted at ${location}`);
        }
      } else {
        this._logger.info(`Mute button not found at ${location}`);
      }
    } catch (error) {
      this._logger.warn(`Failed to mute at ${location}`, { error });
    }
  }
}
