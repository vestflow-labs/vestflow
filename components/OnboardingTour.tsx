"use client";
import { useEffect, useState, useRef } from "react";
import { useWallet } from "@/lib/WalletContext";

interface TourStep {
  id: string;
  title: string;
  description: string;
  targetSelector: string;
  position: "top" | "bottom" | "left" | "right";
}

const TOUR_STEPS: TourStep[] = [
  {
    id: "connect-wallet",
    title: "Connect Your Wallet",
    description: "Click here to connect your Freighter wallet. This is required to create and manage vesting schedules.",
    targetSelector: "[data-tour='wallet-button']",
    position: "bottom",
  },
  {
    id: "create-schedule",
    title: "Create a Schedule",
    description: "Once connected, use this button to create a new vesting schedule for your team or beneficiaries.",
    targetSelector: "[data-tour='create-button']",
    position: "bottom",
  },
  {
    id: "dashboard",
    title: "View Your Schedules",
    description: "Monitor all your active vesting schedules here. You'll see schedules where you're the grantor or beneficiary.",
    targetSelector: "[data-tour='dashboard-link']",
    position: "bottom",
  },
  {
    id: "claim-tokens",
    title: "Claim Vested Tokens",
    description: "When tokens vest, you'll see a claim button. Click it to transfer vested tokens to your wallet.",
    targetSelector: "[data-tour='schedule-card']",
    position: "top",
  },
];

const STORAGE_KEY = "vestflow-tour-completed";

export default function OnboardingTour() {
  const [currentStep, setCurrentStep] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const { publicKey } = useWallet();
  const observerRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    const hasCompleted = localStorage.getItem(STORAGE_KEY);
    if (!hasCompleted) {
      // Delay tour start to let page render
      const timer = setTimeout(() => {
        setIsActive(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const updatePosition = () => {
      const step = TOUR_STEPS[currentStep];
      const target = document.querySelector(step.targetSelector);
      
      if (target) {
        const rect = target.getBoundingClientRect();
        setTargetRect(rect);
        
        let top = 0;
        let left = 0;
        
        switch (step.position) {
          case "bottom":
            top = rect.bottom + window.scrollY + 16;
            left = rect.left + window.scrollX + rect.width / 2;
            break;
          case "top":
            top = rect.top + window.scrollY - 16;
            left = rect.left + window.scrollX + rect.width / 2;
            break;
          case "left":
            top = rect.top + window.scrollY + rect.height / 2;
            left = rect.left + window.scrollX - 16;
            break;
          case "right":
            top = rect.top + window.scrollY + rect.height / 2;
            left = rect.right + window.scrollX + 16;
            break;
        }
        
        setPosition({ top, left });
      }
    };

    updatePosition();
    
    // Watch for DOM changes
    observerRef.current = new MutationObserver(updatePosition);
    observerRef.current.observe(document.body, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition);

    return () => {
      observerRef.current?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition);
    };
  }, [isActive, currentStep]);

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleComplete = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsActive(false);
  };

  if (!isActive) return null;

  const step = TOUR_STEPS[currentStep];
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70 z-[9997]" />
      
      {/* Spotlight on target element */}
      {targetRect && (
        <div
          className="fixed z-[9998] pointer-events-none"
          style={{
            top: targetRect.top + window.scrollY,
            left: targetRect.left + window.scrollX,
            width: targetRect.width,
            height: targetRect.height,
            boxShadow: prefersReducedMotion 
              ? "0 0 0 4px rgba(139, 92, 246, 0.5)"
              : "0 0 0 4px rgba(139, 92, 246, 0.5), 0 0 20px 10px rgba(139, 92, 246, 0.3)",
            borderRadius: "8px",
            transition: prefersReducedMotion ? "none" : "all 0.3s ease",
          }}
        />
      )}

      {/* Tour tooltip */}
      <div
        className="fixed z-[9999] w-80"
        style={{
          top: position.top,
          left: position.left,
          transform: step.position === "bottom" || step.position === "top" 
            ? "translateX(-50%)" 
            : step.position === "left" 
            ? "translate(-100%, -50%)" 
            : "translateY(-50%)",
        }}
      >
        <div className="card p-5 flex flex-col gap-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className="text-base font-bold mb-1">{step.title}</h3>
              <p className="text-sm text-zinc-400">{step.description}</p>
            </div>
            <button
              onClick={handleSkip}
              className="text-zinc-500 hover:text-white transition-colors text-sm"
              aria-label="Skip tour"
            >
              Skip
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {TOUR_STEPS.map((_, index) => (
                <div
                  key={index}
                  className={`h-1.5 rounded-full transition-all ${
                    index === currentStep
                      ? "w-8 bg-violet-500"
                      : index < currentStep
                      ? "w-1.5 bg-violet-500/50"
                      : "w-1.5 bg-zinc-700"
                  }`}
                />
              ))}
            </div>
            
            <button
              onClick={handleNext}
              className="btn-primary px-4 py-1.5 text-sm font-semibold rounded-lg"
            >
              {currentStep === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
