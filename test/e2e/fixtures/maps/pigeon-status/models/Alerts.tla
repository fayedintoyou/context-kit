---------------------------- MODULE Alerts ----------------------------
\* A fictional model of Pigeon's desktop pop-ups. TLC finds a state where
\* the laptop and the tablet both show a pop-up for one mention.
EXTENDS Naturals, FiniteSets

VARIABLES popups

Devices == {"laptop", "tablet"}

Init == popups = {}

Mention == popups' = Devices

OnePopup == Cardinality(popups) <= 1

Spec == Init /\ [][Mention]_popups
=============================================================================
