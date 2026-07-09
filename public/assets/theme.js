// Shared Tailwind CDN config — single source of truth for colors, spacing,
// fonts, etc. used across all watobot pages. Load the Tailwind CDN script
// before this one.
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      "colors": {
        "on-surface-variant": "#3c4a3d",
        "inverse-surface": "#2d3133",
        "on-surface": "#191c1e",
        "error": "#ba1a1a",
        "tertiary-fixed": "#c0e8ff",
        "on-tertiary-container": "#004f69",
        "secondary-container": "#76f6cd",
        "on-error": "#ffffff",
        "surface-bright": "#f7f9fc",
        "surface-container-lowest": "#ffffff",
        "on-error-container": "#93000a",
        "on-primary-container": "#005523",
        "on-secondary": "#ffffff",
        "background": "#f7f9fc",
        "inverse-on-surface": "#eff1f4",
        "secondary": "#006b53",
        "error-container": "#ffdad6",
        "secondary-fixed-dim": "#59dcb5",
        "on-background": "#191c1e",
        "surface-container-high": "#e6e8eb",
        "on-primary-fixed-variant": "#005322",
        "surface-container": "#eceef1",
        "surface": "#f7f9fc",
        "on-secondary-container": "#007057",
        "surface-tint": "#006d2f",
        "primary-fixed-dim": "#3de273",
        "secondary-fixed": "#79f9d0",
        "on-tertiary-fixed": "#001e2b",
        "surface-container-highest": "#e0e3e6",
        "tertiary": "#006686",
        "tertiary-fixed-dim": "#70d2ff",
        "on-secondary-fixed-variant": "#00513e",
        "surface-dim": "#d8dadd",
        "on-secondary-fixed": "#002117",
        "primary-container": "#25d366",
        "on-primary": "#ffffff",
        "primary": "#006d2f",
        "outline": "#6c7b6b",
        "tertiary-container": "#5bc4f2",
        "outline-variant": "#bbcbb9",
        "inverse-primary": "#3de273",
        "surface-container-low": "#f2f4f7",
        "primary-fixed": "#66ff8e",
        "on-primary-fixed": "#002109",
        "on-tertiary-fixed-variant": "#004d66",
        "on-tertiary": "#ffffff",
        "surface-variant": "#e0e3e6"
      },
      "borderRadius": {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
      "spacing": {
        "stack-gap": "12px",
        "unit": "4px",
        "gutter": "16px",
        "sidebar-width": "320px",
        "container-padding": "24px"
      },
      "fontFamily": {
        "body-lg": ["Inter"],
        "code-sm": ["Geist"],
        "headline-md": ["Plus Jakarta Sans"],
        "headline-lg": ["Plus Jakarta Sans"],
        "label-md": ["Inter"],
        "body-md": ["Inter"]
      },
      "fontSize": {
        "body-lg": ["16px", {"lineHeight": "24px", "fontWeight": "400"}],
        "code-sm": ["12px", {"lineHeight": "16px", "fontWeight": "400"}],
        "headline-md": ["20px", {"lineHeight": "28px", "fontWeight": "600"}],
        "headline-lg": ["28px", {"lineHeight": "36px", "letterSpacing": "-0.02em", "fontWeight": "700"}],
        "label-md": ["13px", {"lineHeight": "18px", "letterSpacing": "0.05em", "fontWeight": "600"}],
        "body-md": ["14px", {"lineHeight": "20px", "fontWeight": "400"}]
      }
    }
  }
};
