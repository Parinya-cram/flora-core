"""Outbound interface: Canopy sends case data to hospital systems as HL7 v2 or FHIR R4.

messages.py builds the messages, transport.py delivers them, worker.py detects events,
queues them and sends what is due. Destinations are set in Canopy (routes/outbound_admin.py).
"""
