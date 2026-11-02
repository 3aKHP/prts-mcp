//! Exit-code classification at the management command boundary.
#[derive(Debug)]
pub struct Failure {
    pub code: i32,
    pub message: String,
}
impl Failure {
    pub fn operation(error: impl std::fmt::Display) -> Self {
        Self {
            code: 1,
            message: error.to_string(),
        }
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { code: 2, message }
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
