import { useCallback, useEffect, useState } from 'react';
import { CallOverlay } from './components/CallOverlay';
import { ChatViewport } from './components/ChatViewport';
import { CreateRoomModal } from './components/CreateRoomModal';
import { NetworkStatusModal } from './components/NetworkStatusModal';
import { OnboardingModal } from './components/OnboardingModal';
import { RoomCallPickerModal } from './components/RoomCallPickerModal';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { VerificationModal } from './components/VerificationModal';
import { WifiShareModal } from './components/WifiShareModal';
import { useLocalChat } from './hooks/useLocalChat';
import type { CallType, ChatTarget } from './types/chat';

export default function App() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lokakirim_theme') !== 'light';
    } catch {
      return true;
    }
  });

  // WhatsApp Android two-screen navigation on mobile (< 1024px)
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [wifiShareOpen, setWifiShareOpen] = useState(false);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [roomCallPicker, setRoomCallPicker] = useState<{
    open: boolean;
    callType: CallType;
  }>({ open: false, callType: 'audio' });

  useEffect(() => {
    const root = document.documentElement;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (isDark) {
      root.classList.add('dark');
      themeMeta?.setAttribute('content', '#202C33');
      try {
        localStorage.setItem('lokakirim_theme', 'dark');
      } catch {
        // ignore
      }
    } else {
      root.classList.remove('dark');
      themeMeta?.setAttribute('content', '#F0F2F5');
      try {
        localStorage.setItem('lokakirim_theme', 'light');
      } catch {
        // ignore
      }
    }
  }, [isDark]);

  // Sync Android hardware/gesture Back button with mobile list <-> chat navigation
  useEffect(() => {
    const handlePopState = () => {
      setMobileView('list');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const {
    identity,
    identityReady,
    needsOnboarding,
    completeOnboarding,
    renameSelf,
    peers,
    rooms,
    activeTarget,
    setActiveTarget,
    activeMessages,
    lastMessages,
    unreadCounts,
    telemetry,
    lanInfo,
    refreshLanInfo,
    roomSafetyCodes,
    dmSafetyCodes,
    verifiedPeers,
    verifiedRooms,
    markPeerVerified,
    markRoomVerified,
    fileUrls,
    createRoom,
    joinRoom,
    sendTextMessage,
    sendFiles,
    cancelTransfer,
    clearActiveConversation,
    clearAllHistory,
    hostUrl,
    isTauriApp,
    probeHost,
    switchHostUrl,
    resetHostToLocal,
    hostRuntimes,
    localHostConfig,
    hostBridges,
    refreshHostManagement,
    updateLocalHostConfig,
    addRemoteHost,
    removeRemoteHost,
    toggleHostEnabled,
    updateHostAccessCode,
    addHostBridge,
    removeHostBridge,
    packetTraces,
    lastSyncFailure,
    formatPacketTraceReport,
    getRustPacketTraces,
    callSession,
    localCallStream,
    remoteCallStream,
    callAudioLevels,
    startCall,
    acceptCall,
    rejectCall,
    hangupCall,
    toggleCallAudioMute,
    toggleCallVideoMute,
    toggleCallSpeakerMute,
    switchCallCamera,
    toggleCallMinimized,
    setCallRemoteCanvas,
    forceRustCallRelay,
  } = useLocalChat();

  // Keep Android screen awake during active large-file chunk transfers or live calls
  const hasActiveCall = Boolean(
    callSession &&
      (callSession.status === 'outgoing' ||
        callSession.status === 'incoming' ||
        callSession.status === 'connecting' ||
        callSession.status === 'active')
  );
  const hasActiveFileTransfer =
    hasActiveCall ||
    activeMessages.some(
      (m) =>
        m.kind === 'file' &&
        (m.file?.status === 'sending' || m.file?.status === 'receiving')
    );

  useEffect(() => {
    if (!hasActiveFileTransfer) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;

    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };

    if (nav.wakeLock) {
      nav.wakeLock
        .request('screen')
        .then((s) => {
          if (cancelled) {
            s.release().catch(() => {});
          } else {
            sentinel = s;
          }
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      sentinel?.release().catch(() => {});
    };
  }, [hasActiveFileTransfer]);

  const handleSelectTargetMobileAware = useCallback(
    (target: ChatTarget) => {
      setActiveTarget(target);
      if (window.innerWidth < 1024) {
        if (window.history.state?.lokakirimView !== 'chat') {
          window.history.pushState({ lokakirimView: 'chat' }, '');
        }
        setMobileView('chat');
      }
    },
    [setActiveTarget]
  );

  const handleJoinRoomMobileAware = useCallback(
    (roomId: string) => {
      joinRoom(roomId);
      if (window.innerWidth < 1024) {
        if (window.history.state?.lokakirimView !== 'chat') {
          window.history.pushState({ lokakirimView: 'chat' }, '');
        }
        setMobileView('chat');
      }
    },
    [joinRoom]
  );

  const handleMobileBack = useCallback(() => {
    if (window.history.state?.lokakirimView === 'chat') {
      window.history.back();
    } else {
      setMobileView('list');
    }
  }, []);

  const activeRoom =
    activeTarget.type === 'room'
      ? rooms.find((r) => r.roomId === activeTarget.id)
      : undefined;

  const activePeer =
    activeTarget.type === 'dm'
      ? peers.find((p) => p.peerId === activeTarget.id)
      : undefined;

  const activeSafetyCode =
    activeTarget.type === 'room'
      ? roomSafetyCodes[activeTarget.id] || ''
      : dmSafetyCodes[activeTarget.id] || '';

  const isActiveVerified =
    activeTarget.type === 'room'
      ? Boolean(verifiedRooms[activeTarget.id])
      : Boolean(verifiedPeers[activeTarget.id]);

  const activeTargetName =
    activeTarget.type === 'room'
      ? activeRoom?.name || 'Ruang Lokal'
      : activePeer?.displayName || 'Perangkat Offline';

  const isTargetOffline = activeTarget.type === 'dm' && !activePeer;

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-[#EFEAE2] dark:bg-[#0B141A] text-slate-900 dark:text-[#E9EDEF]">
      <Sidebar
        visibleOnMobile={mobileView === 'list'}
        identity={identity}
        onRenameSelf={renameSelf}
        rooms={rooms}
        peers={peers}
        activeTarget={activeTarget}
        onSelectTarget={handleSelectTargetMobileAware}
        onJoinRoom={handleJoinRoomMobileAware}
        lastMessages={lastMessages}
        unreadCounts={unreadCounts}
        telemetry={telemetry}
        verifiedPeers={verifiedPeers}
        localHostConfig={localHostConfig}
        hostRuntimes={hostRuntimes}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
        onOpenNetworkStatus={() => setNetworkOpen(true)}
        onOpenCreateRoom={() => setCreateRoomOpen(true)}
        onOpenWifiShare={() => setWifiShareOpen(true)}
        onClearAllHistory={clearAllHistory}
      />

      <main
        className={`${
          mobileView === 'chat' ? 'flex' : 'hidden lg:flex'
        } flex-1 flex-col min-w-0 h-full`}
      >
        <TopBar
          onMobileBack={handleMobileBack}
          activeTarget={activeTarget}
          activeRoom={activeRoom}
          activePeer={activePeer}
          isVerified={isActiveVerified}
          telemetry={telemetry}
          isDark={isDark}
          onToggleTheme={() => setIsDark((d) => !d)}
          onOpenVerification={() => setVerifyOpen(true)}
          onOpenNetworkStatus={() => setNetworkOpen(true)}
          onOpenWifiShare={() => setWifiShareOpen(true)}
          onClearActiveHistory={() => clearActiveConversation(activeTarget)}
          callDisabled={Boolean(
            (activeTarget.type === 'dm' && isTargetOffline) ||
              (callSession && callSession.status !== 'ended')
          )}
          onStartVoiceCall={() => {
            if (activeTarget.type === 'dm' && activePeer) {
              void startCall(activePeer.peerId, 'audio');
            } else {
              setRoomCallPicker({ open: true, callType: 'audio' });
            }
          }}
          onStartVideoCall={() => {
            if (activeTarget.type === 'dm' && activePeer) {
              void startCall(activePeer.peerId, 'video');
            } else {
              setRoomCallPicker({ open: true, callType: 'video' });
            }
          }}
        />

        <ChatViewport
          messages={activeMessages}
          selfPeerId={identity?.peerId || ''}
          fileUrls={fileUrls}
          isTargetOffline={isTargetOffline}
          isGroupChat={activeTarget.type === 'room'}
          onOpenVerification={() => setVerifyOpen(true)}
          onSendText={(txt) => sendTextMessage(activeTarget, txt)}
          onSendFiles={(files) => sendFiles(activeTarget, files)}
          onCancelTransfer={cancelTransfer}
        />
      </main>

      <OnboardingModal
        open={identityReady && needsOnboarding}
        onComplete={completeOnboarding}
      />

      <VerificationModal
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        targetName={activeTargetName}
        targetType={activeTarget.type}
        safetyCode={activeSafetyCode}
        isVerified={isActiveVerified}
        onToggleVerify={(v) => {
          if (activeTarget.type === 'room') {
            markRoomVerified(activeTarget.id, v);
          } else {
            markPeerVerified(activeTarget.id, v);
          }
        }}
      />

      <NetworkStatusModal
        open={networkOpen}
        onClose={() => setNetworkOpen(false)}
        telemetry={telemetry}
        isTauriApp={isTauriApp}
        hostUrl={hostUrl}
        packetTraces={packetTraces}
        lastSyncFailure={lastSyncFailure}
        formatPacketTraceReport={formatPacketTraceReport}
        getRustPacketTraces={getRustPacketTraces}
      />

      <WifiShareModal
        open={wifiShareOpen}
        onClose={() => setWifiShareOpen(false)}
        lanInfo={lanInfo}
        onRefresh={refreshLanInfo}
        hostUrl={hostUrl}
        isTauriApp={isTauriApp}
        onProbeHost={probeHost}
        onSwitchHost={switchHostUrl}
        onResetHost={resetHostToLocal}
        localHostConfig={localHostConfig}
        hostRuntimes={hostRuntimes}
        hostBridges={hostBridges}
        onRefreshHostManagement={refreshHostManagement}
        onUpdateLocalHostConfig={updateLocalHostConfig}
        onAddRemoteHost={addRemoteHost}
        onRemoveRemoteHost={removeRemoteHost}
        onToggleHostEnabled={toggleHostEnabled}
        onUpdateHostAccessCode={updateHostAccessCode}
        onAddHostBridge={addHostBridge}
        onRemoveHostBridge={removeHostBridge}
      />

      <CreateRoomModal
        open={createRoomOpen}
        onClose={() => setCreateRoomOpen(false)}
        onCreate={async (name) => {
          const roomId = await createRoom(name);
          if (roomId && window.innerWidth < 1024) {
            if (window.history.state?.lokakirimView !== 'chat') {
              window.history.pushState({ lokakirimView: 'chat' }, '');
            }
            setMobileView('chat');
          }
        }}
      />

      <RoomCallPickerModal
        open={roomCallPicker.open}
        initialCallType={roomCallPicker.callType}
        roomName={activeTargetName}
        peers={peers}
        onClose={() => setRoomCallPicker((prev) => ({ ...prev, open: false }))}
        onStartCall={(peerId, callType) => {
          void startCall(peerId, callType);
        }}
      />

      <CallOverlay
        session={callSession}
        localStream={localCallStream}
        remoteStream={remoteCallStream}
        audioLevels={callAudioLevels}
        isTauriApp={isTauriApp}
        onAccept={() => {
          void acceptCall();
        }}
        onReject={() => {
          void rejectCall();
        }}
        onHangup={() => {
          void hangupCall();
        }}
        onToggleAudioMute={toggleCallAudioMute}
        onToggleVideoMute={toggleCallVideoMute}
        onToggleSpeakerMute={toggleCallSpeakerMute}
        onSwitchCamera={() => {
          void switchCallCamera();
        }}
        onToggleMinimized={toggleCallMinimized}
        onBindRemoteCanvas={setCallRemoteCanvas}
        onForceRustRelay={forceRustCallRelay}
      />
    </div>
  );
}
