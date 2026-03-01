import React, { useState } from 'react';
import { motion } from 'framer-motion';

interface CapabilitiesGridProps {
  onCommand: (text: string) => void;
}

const CAPABILITIES = [
  {
    icon: '🌐',
    title: 'Browse',
    desc: 'Open any page, navigate, click',
    examples: [
      'Open YouTube',
      'Go to Gmail',
      'Open reddit.com/r/technology',
    ],
  },
  {
    icon: '🔍',
    title: 'Research',
    desc: 'Search, compare, find info',
    examples: [
      'Find the cheapest flight to London',
      'Compare iPhone 16 vs Samsung S25',
      'What are the latest AI news?',
    ],
  },
  {
    icon: '✏️',
    title: 'Create',
    desc: 'Draw diagrams, flowcharts, visuals',
    examples: [
      'Draw a flowchart of user signup',
      'Create an architecture diagram',
      'Make a mind map of project ideas',
    ],
  },
  {
    icon: '📝',
    title: 'Automate',
    desc: 'Fill forms, click buttons, type',
    examples: [
      'Fill this form with my details',
      'Click the sign-up button',
      'Dismiss all popups on this page',
    ],
  },
  {
    icon: '🔄',
    title: 'Monitor',
    desc: 'Watch pages on auto-repeat',
    examples: [
      'Watch r/technology every 30 seconds',
      'Check this page for price changes',
      'Monitor my email every minute',
    ],
  },
  {
    icon: '📖',
    title: 'Annotate',
    desc: 'Read, highlight, summarize pages',
    examples: [
      'Highlight the key points on this page',
      'Summarize this article for me',
      'Read this page and tell me the gist',
    ],
  },
];

export default function CapabilitiesGrid({ onCommand }: CapabilitiesGridProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 10,
      width: '100%',
    }}>
      {CAPABILITIES.map((cap, i) => {
        const isHovered = hoveredIdx === i;
        // Pick a random example on click
        const handleClick = () => {
          const example = cap.examples[Math.floor(Math.random() * cap.examples.length)];
          onCommand(`Hey Lobster, ${example}`);
        };

        return (
          <motion.button
            key={cap.title}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.07 }}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
            onClick={handleClick}
            style={{
              background: isHovered
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(255,255,255,0.03)',
              border: `1px solid ${isHovered ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)'}`,
              borderRadius: 14,
              padding: '16px 14px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 6,
              transition: 'all 0.2s ease',
              position: 'relative',
              overflow: 'hidden',
              textAlign: 'left',
              fontFamily: "'Inter', system-ui, sans-serif",
              outline: 'none',
            }}
          >
            {/* Hover glow */}
            {isHovered && (
              <motion.div
                layoutId="cap-glow"
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'radial-gradient(ellipse at 50% 0%, rgba(200,60,80,0.12) 0%, transparent 70%)',
                  pointerEvents: 'none',
                }}
              />
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, zIndex: 1 }}>
              <span style={{ fontSize: 20 }}>{cap.icon}</span>
              <span style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.9)',
                letterSpacing: '0.01em',
              }}>
                {cap.title}
              </span>
            </div>

            <span style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.4)',
              lineHeight: 1.3,
              zIndex: 1,
            }}>
              {cap.desc}
            </span>

            {/* Example hint on hover */}
            <motion.span
              animate={{ opacity: isHovered ? 1 : 0, y: isHovered ? 0 : 4 }}
              transition={{ duration: 0.15 }}
              style={{
                fontSize: 10,
                color: 'rgba(200,100,100,0.7)',
                fontStyle: 'italic',
                marginTop: 2,
                zIndex: 1,
              }}
            >
              "{cap.examples[0]}"
            </motion.span>
          </motion.button>
        );
      })}
    </div>
  );
}
