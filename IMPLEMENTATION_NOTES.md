# Implementation Notes for Issues 800 802 and 799

## Issue 800 Unsaved Changes Warning

The splits form with unsaved changes warning needs to be implemented in the schedule creation flow. Based on the codebase structure the CreateForm component at components/CreateForm.tsx contains the primary form that would benefit from unsaved changes protection.

### Implementation Approach
1. Add useEffect hook with beforeunload event listener
2. Track form dirty state using React state
3. Add Next.js router event prevention for in-app navigation
4. Clear warning after successful form submission

### Code Pattern
```typescript
useEffect(() => {
  const handleBeforeUnload = (e: BeforeUnloadEvent) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => window.removeEventListener('beforeunload', handleBeforeUnload);
}, [isDirty]);
```

## Issue 802 Stream Configuration Duplication

Stream duplication requires adding a button to stream detail pages and enhancing the stream creation form to accept pre-fill parameters.

### Files to Modify
- app/app/streams/[id]/page.tsx or similar stream detail component
- app/app/streams/new/page.tsx stream creation form
- Add URL query parameter handling for pre-fill

### Implementation Pattern
```typescript
const handleDuplicate = () => {
  router.push(`/app/streams/new?token=${stream.token}&receiver=${stream.receiver}&rate=${stream.ratePerSec}`);
};
```

## Issue 799 Wallet Portfolio Stats Page

Create a new stats dashboard page at app/app/stats/page.tsx that aggregates wallet metrics.

### Required Data
- Total tokens sent via getGiveHistory
- Total tokens received via getProfile
- Active streams count via getStreams
- Splits receivers count via getSplits
- Drips lists via getProfile dripsLists

### Implementation Structure
```typescript
export default function StatsPage() {
  const { publicKey } = useWallet();
  const [stats, setStats] = useState(null);
  
  useEffect(() => {
    if (!publicKey) return;
    fetchAllStats(publicKey).then(setStats);
  }, [publicKey]);
  
  return <StatsDisplay stats={stats} />;
}
```

