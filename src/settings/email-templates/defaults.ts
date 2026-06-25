export const DEFAULT_TEMPLATES = {
  fromAddress: 'Rodz Smart Auto <bookings@rodz.com.au>',
  replyTo: '',
  quoteTemplate: {
    subject: 'Your quote from Rodz Smart Auto {{store}} — {{quoteNumber}}',
    body:
      'Hi {{firstName}},\n\n' +
      "We've prepared a quote for your {{vehicle}} ({{rego}}).\n\n" +
      'Quote #{{quoteNumber}}\n\n' +
      'View and approve your quote here:\n{{approvalLink}}\n\n' +
      'If you have any questions, feel free to reply to this email.\n\n' +
      'Rodz Smart Auto {{store}}',
  },
  bookingReceivedTemplate: {
    subject: 'Booking received — {{services}} at Rodz Smart Auto {{store}}',
    body:
      'Hi {{firstName}},\n\n' +
      "Thanks for booking with us! We've received your booking request and will confirm shortly.\n\n" +
      'Vehicle: {{vehicle}} ({{rego}})\n' +
      'Service: {{services}}\n' +
      'Requested date: {{date}}\n' +
      'Time slot: {{slot}}\n\n' +
      'Rodz Smart Auto {{store}}',
  },
  bookingConfirmedTemplate: {
    subject: 'Booking confirmed — {{services}} on {{date}}',
    body:
      'Hi {{firstName}},\n\n' +
      'Great news — your booking is confirmed!\n\n' +
      'Vehicle: {{vehicle}} ({{rego}})\n' +
      'Service: {{services}}\n' +
      'Date: {{date}}\n' +
      'Time slot: {{slot}}\n' +
      'Technician: {{techName}}\n\n' +
      'Rodz Smart Auto {{store}}',
  },
  workCommencedTemplate: {
    subject: 'Work has commenced on your {{vehicle}}',
    body:
      'Hi {{firstName}},\n\n' +
      "Just letting you know that work has started on your {{vehicle}} ({{rego}}).\n\n" +
      'Job: {{jobNumber}}\n' +
      'Technician: {{techName}}\n' +
      'Service: {{services}}\n' +
      'Store: {{store}}\n\n' +
      "We'll be in touch when your vehicle is ready.\n\n" +
      'Rodz Smart Auto',
  },
  workCompleteTemplate: {
    subject: 'Your {{vehicle}} is ready for pickup',
    body:
      'Hi {{firstName}},\n\n' +
      'Great news — your {{vehicle}} ({{rego}}) is ready for pickup!\n\n' +
      'Job: {{jobNumber}}\n' +
      'Service: {{services}}\n\n' +
      'Rodz Smart Auto {{store}}',
  },
  invoiceTemplate: {
    subject: 'Your invoice {{invoiceNumber}} from Rodz Smart Auto',
    body:
      'Hi {{firstName}},\n\n' +
      'Please find your invoice below.\n\n' +
      'Invoice: {{invoiceNumber}}\n' +
      'Vehicle: {{vehicle}}\n' +
      'Total: {{total}}\n\n' +
      'View and pay your invoice here:\n{{invoiceLink}}\n\n' +
      'If you have any questions, feel free to reply to this email.\n\n' +
      'Rodz Smart Auto',
  },
  logbookTemplate: {
    subject: 'Your digital logbook — {{vehicle}}',
    body:
      'Hi {{firstName}},\n\n' +
      'Your digital logbook for your {{vehicle}} ({{rego}}) is ready to view.\n\n' +
      'View your logbook here:\n{{logbookLink}}\n\n' +
      'This link is unique to your vehicle and can be bookmarked for future reference.\n\n' +
      'Rodz Smart Auto {{store}}',
  },
}
