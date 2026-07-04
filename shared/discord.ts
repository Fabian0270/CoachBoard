// Discord integration — API contract types shared between client and server.
// Wire shapes for /api/discord/*. Server DB tables (DiscordMediaTable etc.) are
// internal to the server; these are what actually travels over HTTP.

/** Settings as exposed to the client. Never contains the bot token. */
export interface PublicDiscordSettings {
  configured: boolean
  botUsername: string | null
  applicationId: string | null
  /** Full OAuth invite URL (permissions 68608), null until a token is saved. */
  inviteUrl: string | null
  autoSyncEnabled: boolean
  autoSyncMinutes: number
  /** Auto-delete synced videos older than this many days; 0 = Never. */
  retentionDays: number
  /** Auto-delete DM messages older than this many days; 0 = Never. */
  messageRetentionDays: number
  /** True after a 401 — the coach must paste a fresh token ("Reconnect"). */
  tokenInvalid: boolean
  /**
   * Whether the app has the Message Content Intent enabled. Populated only by
   * the token-validation response (PUT /settings/token) so the wizard can warn
   * immediately; undefined elsewhere.
   */
  messageContentIntent?: boolean
}

export interface DiscordGuildDto {
  id: string
  name: string
}

/** A guild channel offered in the setup wizard's channel picker. */
export interface DiscordChannelOptionDto {
  id: string
  name: string
  /** Already present in discord_channels — shown disabled in the picker. */
  alreadyConfigured: boolean
}

/** A configured (synced) channel row. */
export interface ConfiguredChannelDto {
  id: string
  kind: 'guild' | 'dm'
  guildId: string | null
  name: string
  guildName: string | null
  dmUserId: string | null
  enabled: boolean
  lastSyncedAt: string | null
  syncError: 'forbidden' | 'not_found' | null
}

export interface GuildMemberHit {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

/** Values parsed out of a message caption like "180 kg for 2 @8". */
export interface ParsedCaption {
  weightKg: number | null
  reps: number | null
  rpe: number | null
  liftKeywords: string[]
}

export type DownloadStatus = 'pending' | 'downloaded' | 'failed' | 'skipped_too_large'

export interface DiscordMediaItem {
  id: string
  channelId: string
  channelName: string | null
  messageId: string
  discordUserId: string
  authorUsername: string
  authorDisplayName: string | null
  authorAvatarUrl: string | null
  athleteId: string | null
  athleteName: string | null
  workoutId: string | null
  workoutName: string | null
  workoutDate: string | null
  suggestedWorkoutId: string | null
  suggestedWorkoutName: string | null
  suggestedWorkoutDate: string | null
  programId: string | null
  programName: string | null
  filename: string
  contentType: string | null
  sizeBytes: number
  width: number | null
  height: number | null
  caption: string | null
  parsedCaption: ParsedCaption | null
  postedAt: string
  downloadStatus: DownloadStatus
  downloadError: string | null
  duplicateOfId: string | null
  reviewed: boolean
  /** True when the file is downloaded and /media/:id/file will serve it. */
  playable: boolean
  isVideo: boolean
}

export interface DiscordUserItem {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  athleteId: string | null
  athleteName: string | null
  mediaCount: number
  firstSeenAt: string
}

export interface InboxCounts {
  unmatched: number
  unreviewed: number
  /** Unread inbound DM messages from athletes. */
  unreadMessages: number
}

/** One message in a per-athlete DM conversation (inbound or outbound). */
export interface ConversationMessage {
  id: string
  direction: 'in' | 'out'
  content: string
  timestamp: string
  /** Outbound only: whether Discord accepted the send. */
  status?: 'sent' | 'failed'
  error?: string | null
}

/** An athlete with unread inbound DMs, for the Inbox → Messages tab. */
export interface UnreadThread {
  athleteId: string
  athleteName: string
  unread: number
  lastMessage: string
  lastAt: string
}

/** A nearby workout the coach can attach media to ("Pick other…"). */
export interface WorkoutCandidate {
  workoutId: string
  workoutName: string
  scheduledDate: string | null
  programId: string
  programName: string
}

export interface SyncChannelProgress {
  channelId: string
  name: string
  fetched: number
  newMedia: number
  done: boolean
  error: string | null
}

export interface SyncStatusDto {
  state: 'idle' | 'running'
  startedAt: string | null
  channels: SyncChannelProgress[]
  downloads: { total: number; completed: number; failed: number; skipped: number }
  /** e.g. 'intent_missing:#form-checks' */
  warnings: string[]
  lastResult: {
    finishedAt: string
    code: 'ok' | 'unauthorized' | 'offline' | 'error'
    newMedia: number
    message?: string
  } | null
}

export interface StartSyncResult {
  started: boolean
  reason?: 'already_running' | 'not_configured' | 'token_invalid'
}

export interface SendMessageInput {
  content: string
  /** Reply into the source channel, or DM the author. */
  via: 'channel' | 'dm'
}

export interface SentMessageDto {
  id: string
  kind: 'channel' | 'dm'
  content: string
  status: 'sent' | 'failed'
  error: string | null
  createdAt: string
}
